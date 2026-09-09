import {describe,it,expect,vi} from 'vitest';
import {MeshStandardMaterial,ShaderLib,Texture,Vector2} from 'three';
import {applyGameFacadeGrammar,sampleGameFacadeGrammar} from './gameFacadeGrammar';

describe('metric architectural facade grammar',()=>{
  it('distinguishes panel joints, plaster bands and civic courses at physical metre scales',()=>{
    const panel=sampleGameFacadeGrammar('panel',0,[0,1.5],.005);
    expect(panel.shade).toBeLessThan(sampleGameFacadeGrammar('panel',0,[1.7,1.5],.005).shade-.1);
    expect(sampleGameFacadeGrammar('civic',0,[1.2,.5],.005).shade).toBeLessThan(.9);
    expect(sampleGameFacadeGrammar('plaster',0,[1.2,0],.005).shade).toBeGreaterThan(1);
    expect(new Set(['panel','plaster','civic','neutral'].map(f=>JSON.stringify(sampleGameFacadeGrammar(f as 'panel',1,[3.6,3],.01)))).size).toBe(4);
  });
  it('varies structural bay periods, filters subpixel seams and never creates extra window cards',()=>{
    const a=sampleGameFacadeGrammar('panel',0,[3.6,1.5],.001),b=sampleGameFacadeGrammar('panel',2,[3.6,1.5],.001);
    expect(Math.abs(a.shade-b.shade)).toBeGreaterThan(.1);
    const far=sampleGameFacadeGrammar('panel',0,[0,0],32),farNext=sampleGameFacadeGrammar('panel',0,[1.2,2.1],32);
    expect(far.shade).toBeCloseTo(farNext.shade,6);
    expect(a.windowCoverage).toBe(0);
  });
  it('uses existing metric UVs and shared material, retaining prior shader hooks and cache keys',()=>{
    const material=new MeshStandardMaterial({map:new Texture(),vertexColors:true});material.name='panel';
    material.userData={sourceId:'plastered_wall_02',repeatMeters:[3,3]};
    const hook=vi.fn(),map=material.map;material.onBeforeCompile=hook;material.customProgramCacheKey=()=> 'prior';
    expect(applyGameFacadeGrammar(material)).toBe(true);
    const shader={uniforms:{},vertexShader:ShaderLib.standard.vertexShader,fragmentShader:ShaderLib.standard.fragmentShader};
    material.onBeforeCompile(shader as never,{} as never);
    expect(hook).toHaveBeenCalledOnce();expect(shader.vertexShader).toContain('gameFacadeMetres=uv*');
    expect(shader.fragmentShader).toContain('fwidth(gameFacadeMetres)');
    expect(shader.fragmentShader).not.toContain('texture2D(');
    expect(material.map).toBe(map);expect(material.customProgramCacheKey()).toContain('prior:metric-facade-grammar');
    expect(material.userData.facadeGrammar).toMatchObject({extraAttributes:0,extraDraws:0,extraTextureSamples:0,representation:'visual_synthesis'});
    expect(applyGameFacadeGrammar(material)).toBe(false);
  });
  it('keeps legacy/roof materials and invalid or transformed texture scales untouched',()=>{
    for(const repeat of [[0,3],[NaN,3],[3],null]){
      const m=new MeshStandardMaterial({map:new Texture(),vertexColors:true});m.name='panel';m.userData={sourceId:'plastered_wall_02',repeatMeters:repeat};
      expect(applyGameFacadeGrammar(m)).toBe(false);
    }
    const m=new MeshStandardMaterial({map:new Texture(),vertexColors:true});m.name='metal';m.userData={sourceId:'corrugated_iron',repeatMeters:[3,3]};
    expect(applyGameFacadeGrammar(m)).toBe(false);m.name='panel';m.userData.sourceId='plastered_wall_02';m.map!.repeat=new Vector2(2,1);
    expect(applyGameFacadeGrammar(m)).toBe(false);
  });
});
