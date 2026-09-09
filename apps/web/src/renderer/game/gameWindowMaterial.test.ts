import {describe,it,expect,vi} from 'vitest';
import {MeshStandardMaterial,ShaderLib,Texture,type WebGLRenderer} from 'three';
import {applyGameWindowMaterial,sampleGameWindowFinish} from './gameWindowMaterial';
const make=(name='windowLight')=>{const m=new MeshStandardMaterial();m.name=name;m.userData.representation='visual_synthesis';return m;};
describe('quiet facade glazing',()=>{
  it('keeps daytime lit-window cards below two percent of their night emission',()=>{
    const day=sampleGameWindowFinish(.5,.5,1),night=sampleGameWindowFinish(.5,.5,0);
    expect(day.emissionScale).toBeLessThan(night.emissionScale*.02);expect(night.emissionScale).toBe(1);
    expect(sampleGameWindowFinish(.5,.5,.5).emissionScale).toBeCloseTo(.505);
  });
  it('gives an existing window a soft dark reveal instead of a uniform bright rectangle',()=>{
    expect(sampleGameWindowFinish(0,.5,1).roomShade).toBeLessThan(sampleGameWindowFinish(.5,.5,1).roomShade);
    expect(sampleGameWindowFinish(.5,.85,1).roomShade).toBeLessThan(sampleGameWindowFinish(.5,.15,1).roomShade);
    for(const uv of [[0,0],[1,1],[.5,.5],[-.1,1.1]])expect(sampleGameWindowFinish(...uv as [number,number],1).roomShade).toBeGreaterThan(.4);
    expect(()=>sampleGameWindowFinish(NaN,0,1)).toThrow();
  });
  it('uses one existing mutable daylight uniform across loaded materials without timers or extra maps',()=>{
    const daylight={value:1},a=make(),b=make('windows'),previous=vi.fn();a.onBeforeCompile=previous;
    expect(applyGameWindowMaterial(a,daylight)).toBe(true);expect(applyGameWindowMaterial(b,daylight)).toBe(true);expect(applyGameWindowMaterial(a,daylight)).toBe(false);
    const shader=()=>({vertexShader:ShaderLib.standard.vertexShader,fragmentShader:ShaderLib.standard.fragmentShader,uniforms:{} as Record<string,unknown>}),sa=shader(),sb=shader();
    a.onBeforeCompile(sa,{} as WebGLRenderer);b.onBeforeCompile(sb,{} as WebGLRenderer);expect(previous).toHaveBeenCalledOnce();
    expect(sa.uniforms.gameWindowDaylight).toBe(daylight);expect(sb.uniforms.gameWindowDaylight).toBe(daylight);daylight.value=0;
    expect((sa.uniforms.gameWindowDaylight as {value:number}).value).toBe(0);
    expect(sa.vertexShader).toContain('gameWindowUv=uv');expect(sa.fragmentShader).toContain('totalEmissiveRadiance*=mix');
    expect(a.map).toBeNull();expect(a.normalMap).toBeNull();expect(a.userData.windowFinish.extraDraws).toBe(0);
    expect(sa.fragmentShader).not.toContain('uniform float time');expect(a.color.r).toBeLessThan(.2);
  });
  it('does not change sourced textured glass, unrelated materials or unmarked legacy windows',()=>{
    for(const m of [make('glass'),make('trim'),new MeshStandardMaterial()])expect(applyGameWindowMaterial(m,{value:1})).toBe(false);
    const mapped=make();mapped.map=new Texture();expect(applyGameWindowMaterial(mapped,{value:1})).toBe(false);
    const legacy=make();delete legacy.userData.representation;expect(applyGameWindowMaterial(legacy,{value:1})).toBe(false);
  });
});
