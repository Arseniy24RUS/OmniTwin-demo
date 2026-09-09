import {describe,it,expect,vi} from 'vitest';
import {MeshStandardMaterial,ShaderLib,Texture,Vector2,WebGLRenderer} from 'three';
import {applyGameRoofMaterial,sampleGameRoofMaterial,sampleGameMetalRoofNormalWeight,GAME_ROOF_FILTER_VERSION} from './gameRoofMaterial';

const fixture={representation:'visual_synthesis',sourceId:'corrugated_iron',repeatMeters:[3,3],license:'CC0-1.0'};
const material=(name='metal')=>{const m=new MeshStandardMaterial({map:new Texture(),normalMap:new Texture(),roughnessMap:new Texture(),metalnessMap:new Texture()});m.name=name;m.userData={...fixture,sourceId:name==='bitumen'?'asphalt_02':'corrugated_iron'};m.normalScale=new Vector2(.45,.45);return m;};
describe('runtime metric roof filtering',()=>{
  it('fully removes the measured 15-cycle corrugation at the physical Nyquist limit',()=>{
    // Pinned 1024px e98b839a normal: mean-red FFT has 95.12% energy at
    // 15 cycles across U. Authored three-metre repeat means 0.20m pitch.
    expect(sampleGameRoofMaterial('metal',[0,0],[.2,.2,.2],.1).normalWeight).toBe(0);
    expect(sampleGameRoofMaterial('metal',[0,0],[.2,.2,.2],.35).normalWeight).toBe(0);
    expect(sampleGameMetalRoofNormalWeight(.02,3)).toBeCloseTo(.298);
    expect(sampleGameMetalRoofNormalWeight(.05,3)).toBeGreaterThan(0);
    expect(sampleGameMetalRoofNormalWeight(.1,3)).toBe(0);
    expect(sampleGameMetalRoofNormalWeight(.1,6)).toBeCloseTo(sampleGameMetalRoofNormalWeight(.05,3));
    expect(sampleGameMetalRoofNormalWeight(.05,1.5)).toBe(0);
    let previous=1;
    for(let i=0;i<=300;i++){const weight=sampleGameMetalRoofNormalWeight(i/1000,3);expect(Number.isFinite(weight)).toBe(true);expect(weight).toBeLessThanOrEqual(previous);expect(weight).toBeGreaterThanOrEqual(0);previous=weight;}
    for(const args of [[NaN,3],[-1,3],[.1,0],[.1,Infinity]])expect(()=>sampleGameMetalRoofNormalWeight(...args as [number,number])).toThrow();
  });
  it('filters actual transformed normal U derivatives and records the measured metric pitch without disabling normal maps',()=>{
    const m=material(),normal=m.normalMap,scale=m.normalScale.clone(),shader={vertexShader:ShaderLib.standard.vertexShader,fragmentShader:ShaderLib.standard.fragmentShader,uniforms:{}};
    applyGameRoofMaterial(m);m.onBeforeCompile(shader,{} as WebGLRenderer);
    expect(shader.fragmentShader).toContain('vNormalMapUv.x * roofRepeatMeters.x');
    expect(shader.fragmentShader).toContain('roofRepeatMeters.x / 15.0');
    expect(shader.fragmentShader).toContain('smoothstep(0.125,0.5,roofCorrugationCyclesPerPixel)');
    expect(m.userData.roofFilter.corrugation).toMatchObject({cyclesPerURepeat:15,pitchMeters:.2,fullDetailPixelsPerCycle:8,zeroDetailPixelsPerCycle:2});
    expect(m.normalMap).toBe(normal);expect(m.normalScale.equals(scale)).toBe(true);
  });
  it('does not repeat the source rust/metal mask as bright diagonal stamps on a painted roof',()=>{
    const painted=sampleGameRoofMaterial('metal',[100,80],[.2,.2,.2],.35,0);
    const exposed=sampleGameRoofMaterial('metal',[100,80],[.2,.2,.2],.35,1);
    expect(exposed.metalness-painted.metalness).toBeLessThan(.05);
    expect(exposed.metalness).toBeLessThan(.15);
    expect(sampleGameRoofMaterial('bitumen',[100,80],[.2,.2,.2],.01,1).metalness).toBe(0);
  });
  it('suppresses unresolved metal corrugation instead of aliasing it into a coarse crosshatch',()=>{
    const near=sampleGameRoofMaterial('metal',[123.25,-30],[.22,.23,.24],.005),far=sampleGameRoofMaterial('metal',[123.25,-30],[.22,.23,.24],.35);
    expect(near.normalWeight).toBeGreaterThan(.2);expect(far.normalWeight).toBeLessThan(near.normalWeight*.12);
    expect(far.roughnessFloor).toBeGreaterThan(.85);expect(near.roughnessFloor).toBeGreaterThan(.65);
    const dark=sampleGameRoofMaterial('metal',[123.25,-30],[.1,.1,.1],.35),light=sampleGameRoofMaterial('metal',[123.25,-30],[.4,.4,.4],.35);
    // A recognizable light/dark crack stamp must not survive across a roof at
    // courtyard distance; the larger world field supplies the visible weathering.
    expect(light.color[0]-dark.color[0]).toBeLessThan(.007);
  });
  it('reduces contrast of the repeated asphalt crack while retaining source color and exact metre UV scale',()=>{
    const dark=sampleGameRoofMaterial('bitumen',[100,80],[.025,.025,.025],.05),light=sampleGameRoofMaterial('bitumen',[100,80],[.25,.25,.25],.05);
    const contrast=light.color[0]-dark.color[0];expect(contrast).toBeGreaterThan(.004);expect(contrast).toBeLessThan(.225*.10);
    const farDark=sampleGameRoofMaterial('bitumen',[100,80],[.025,.025,.025],.35),farLight=sampleGameRoofMaterial('bitumen',[100,80],[.25,.25,.25],.35);
    expect(farLight.color[0]-farDark.color[0]).toBeLessThan(.008);
    const m=material('bitumen'),map=m.map,uvState={repeat:m.map!.repeat.clone(),offset:m.map!.offset.clone(),matrix:m.map!.matrix.clone()};
    expect(applyGameRoofMaterial(m)).toBe(true);expect(m.map).toBe(map);expect(m.userData.repeatMeters).toEqual([3,3]);
    expect(m.map!.repeat.equals(uvState.repeat)).toBe(true);expect(m.map!.offset.equals(uvState.offset)).toBe(true);expect(m.map!.matrix.equals(uvState.matrix)).toBe(true);
    expect(m.userData.sourceId).toBe('asphalt_02');expect(m.userData.license).toBe('CC0-1.0');
  });
  it('keeps subdued world variation continuous, independent of a three-metre texture repeat',()=>{
    const a=sampleGameRoofMaterial('bitumen',[98.125,53.75],[.15,.15,.15],.05),b=sampleGameRoofMaterial('bitumen',[101.125,53.75],[.15,.15,.15],.05);
    expect(Math.abs(a.color[0]-b.color[0])).toBeGreaterThan(.00001);
    const left=sampleGameRoofMaterial('bitumen',[23-1e-6,61],[.15,.15,.15],.05),right=sampleGameRoofMaterial('bitumen',[23+1e-6,61],[.15,.15,.15],.05);
    expect(Math.abs(left.color[0]-right.color[0])).toBeLessThan(1e-6);
    for(const type of ['metal','bitumen'] as const)for(const p of [[0,0],[-50000,30000],[257,511]] as const)for(const footprint of [0,.001,.1,1,100]){
      const v=sampleGameRoofMaterial(type,p,[.02,.25,.9],footprint);expect([...v.color,v.normalWeight,v.roughnessFloor].every(Number.isFinite)).toBe(true);
      expect(v.color.every(c=>c>=0&&c<=1)).toBe(true);expect(v.normalWeight).toBeGreaterThanOrEqual(0);expect(v.normalWeight).toBeLessThanOrEqual(1);
    }
    expect(()=>sampleGameRoofMaterial('metal',[NaN,0],[.2,.2,.2],1)).toThrow();expect(()=>sampleGameRoofMaterial('metal',[0,0],[.2,.2,.2],-1)).toThrow();
  });
  it('composes an idempotent bounded shader hook, with no new textures, geometry, clocks or draw passes',()=>{
    const m=material(),previous=vi.fn(),oldKey='existing-material-pass';m.onBeforeCompile=previous;m.customProgramCacheKey=()=>oldKey;
    const originals=[m.map,m.normalMap,m.roughnessMap,m.metalnessMap],shader={vertexShader:ShaderLib.standard.vertexShader,fragmentShader:ShaderLib.standard.fragmentShader,uniforms:{}};
    expect(applyGameRoofMaterial(m)).toBe(true);expect(applyGameRoofMaterial(m)).toBe(false);m.onBeforeCompile(shader,{} as WebGLRenderer);
    expect(previous).toHaveBeenCalledTimes(1);expect(m.customProgramCacheKey()).toContain(oldKey);expect(m.customProgramCacheKey()).toContain(GAME_ROOF_FILTER_VERSION);
    expect(shader.vertexShader).toContain('modelMatrix * vec4( transformed, 1.0 )');expect(shader.fragmentShader).toContain('dFdx( vMapUv * roofRepeatMeters )');
    expect(shader.fragmentShader).toContain('mapN.xy *= roofNormalWeight');expect(shader.fragmentShader).toContain('roughnessFactor = max');
    expect(shader.fragmentShader).not.toContain('uniform float time');expect([m.map,m.normalMap,m.roughnessMap,m.metalnessMap]).toEqual(originals);
    expect(m.userData.roofFilter.representation).toBe('visual_synthesis');
  });
  it('leaves facade materials, legacy atlas surfaces and absent or invalid metadata untouched',()=>{
    for(const m of [material('industrial'),material('windows'),new MeshStandardMaterial()]){const hook=m.onBeforeCompile;expect(applyGameRoofMaterial(m)).toBe(false);expect(m.onBeforeCompile).toBe(hook);}
    for(const data of [{},{...fixture,sourceId:'unverified'},{...fixture,repeatMeters:[0,3]},{...fixture,repeatMeters:[3,NaN]}]){const m=material();m.userData=data;expect(applyGameRoofMaterial(m)).toBe(false);}
  });
});
