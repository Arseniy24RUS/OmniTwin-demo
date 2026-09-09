import {ShaderChunk,Vector2,type Material,type MeshStandardMaterial} from 'three';

export const GAME_ROOF_FILTER_VERSION='metric-roof-filter-v2';
type RoofKind='metal'|'bitumen';
type Point=readonly [number,number];
type RGB=readonly [number,number,number];
const ANCHOR={metal:[.21,.225,.228],bitumen:[.13,.145,.15]} as const;
const SOURCE_WEIGHT={metal:[.015,.05],bitumen:[.02,.08]} as const;
const mod=(v:number,p:number)=>((v%p)+p)%p;
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const smooth=(a:number,b:number,v:number)=>{const t=Math.max(0,Math.min(1,(v-a)/(b-a)));return t*t*(3-2*t);};
function hash(x:number,z:number){let h=(Math.imul(mod(x,4096),1597334677)^Math.imul(mod(z,4096),3812015801))>>>0;h=Math.imul(h^(h>>>13),1274126177)>>>0;return(h&65535)/65535;}
function noise(x:number,z:number){const ix=Math.floor(x),iz=Math.floor(z),fx=x-ix,fz=z-iz,u=fx*fx*(3-2*fx),v=fz*fz*(3-2*fz);return mix(mix(hash(ix,iz),hash(ix+1,iz),u),mix(hash(ix,iz+1),hash(ix+1,iz+1),u),v);}

/** CPU reference. Inputs are linear color, world metres and metres per pixel.
 * It never changes source UV density, roof geometry or physical source records. */
export function sampleGameRoofMaterial(kind:RoofKind,worldMeters:Point,sourceColor:RGB,pixelFootprint:number,sourceMetalness=kind==='metal'?1:0){
  if(!['metal','bitumen'].includes(kind)||!worldMeters.every(Number.isFinite)||!sourceColor.every(v=>Number.isFinite(v)&&v>=0&&v<=1)
    ||!Number.isFinite(pixelFootprint)||pixelFootprint<0||!Number.isFinite(sourceMetalness)||sourceMetalness<0||sourceMetalness>1)throw Error('Invalid metric roof sample');
  const detail=1-smooth(.018,.18,pixelFootprint),bitumen=kind==='bitumen';
  const macro=1+(noise(worldMeters[0]/23,worldMeters[1]/23)-.5)*.10
    +(noise((worldMeters[0]+worldMeters[1])*.707106781/61,(worldMeters[1]-worldMeters[0])*.707106781/61)-.5)*.06;
  const sourceWeight=mix(SOURCE_WEIGHT[kind][0],SOURCE_WEIGHT[kind][1],detail);
  return{color:sourceColor.map((v,i)=>mix(ANCHOR[kind][i]!,v,sourceWeight)*macro) as [number,number,number],
    normalWeight:bitumen?.02+.30*detail:.018+.28*detail,roughnessFloor:bitumen?.94:.76+.14*(1-detail),
    metalness:bitumen?0:mix(.035,sourceMetalness,.03+.09*detail)};
}

const FIELD=/* glsl */`
varying vec2 roofWorldMetres;
uniform vec2 roofRepeatMeters;
float roofHash(vec2 cell){
  uvec2 p=uvec2(mod(cell,vec2(4096.0)));
  uint h=(p.x*1597334677u)^(p.y*3812015801u);
  h=(h^(h>>13u))*1274126177u;
  return float(h&65535u)/65535.0;
}
float roofNoise(vec2 p){
  vec2 cell=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);
  return mix(mix(roofHash(cell),roofHash(cell+vec2(1.0,0.0)),u.x),
    mix(roofHash(cell+vec2(0.0,1.0)),roofHash(cell+vec2(1.0)),u.x),u.y);
}
`;

/** A restrained presentation treatment for the two pinned roof sources. No
 * resource clones, additional samplers, draw calls, clocks or repaint loop.
 * The footprint filter acts before tangent-space normalization, so unresolved
 * normal variance cannot become a coarse specular crosshatch. */
export function applyGameRoofMaterial(input:Material):boolean{
  const material=input as MeshStandardMaterial,kind=material.name as RoofKind,repeat=material.userData.repeatMeters;
  if(!material.isMeshStandardMaterial||!material.map||!['metal','bitumen'].includes(kind)
    ||material.userData.sourceId!==(kind==='metal'?'corrugated_iron':'asphalt_02')
    ||!Array.isArray(repeat)||repeat.length!==2||repeat.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<.1||v>64)
    ||material.userData.roofFilter?.version===GAME_ROOF_FILTER_VERSION)return false;
  const prior=material.onBeforeCompile,priorKey=material.customProgramCacheKey(),bitumen=kind==='bitumen';
  const anchor=ANCHOR[kind].join(','),weights=SOURCE_WEIGHT[kind];
  const sourceWeight=`mix(${weights[0].toFixed(3)},${weights[1].toFixed(3)},roofResolvedDetail)`;
  const NORMAL=ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;','mapN.xy *= normalScale;\nmapN.xy *= roofNormalWeight;');
  const MAP=ShaderChunk.map_fragment.replace('diffuseColor *= sampledDiffuseColor;',
    `sampledDiffuseColor.rgb=mix(vec3(${anchor}),sampledDiffuseColor.rgb,${sourceWeight})*roofMacroShade;\ndiffuseColor *= sampledDiffuseColor;`);
  material.userData.roofFilter={version:GAME_ROOF_FILTER_VERSION,representation:'visual_synthesis',sourceKind:kind,
    physicalUvUnchanged:true,sourceColorWeight:[...weights],pixelFootprintMeters:[.018,.18],normalDetailPolicy:'attenuate_unresolved_normal_variance',
    surfaceFinish:bitumen?'nonmetallic_bitumen':'painted_weathered_metal',metalMaskWeight:bitumen?0:[.03,.12],extraTextureSamples:0};
  material.onBeforeCompile=(shader,renderer)=>{
    prior.call(material,shader,renderer);shader.uniforms.roofRepeatMeters={value:new Vector2(repeat[0],repeat[1])};
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 roofWorldMetres;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nroofWorldMetres=(modelMatrix * vec4( transformed, 1.0 )).xz;');
    const detail=/* glsl */`
float roofPixelFootprint=max(length(dFdx( vMapUv * roofRepeatMeters )),length(dFdy( vMapUv * roofRepeatMeters )));
float roofResolvedDetail=1.0-smoothstep(0.018,0.18,roofPixelFootprint);
float roofNormalWeight=${bitumen?'0.02+0.30':'0.018+0.28'}*roofResolvedDetail;
float roofMacroShade=1.0+(roofNoise(roofWorldMetres/23.0)-0.5)*0.10
  +(roofNoise(vec2(roofWorldMetres.x+roofWorldMetres.y,roofWorldMetres.y-roofWorldMetres.x)*0.707106781/61.0)-0.5)*0.06;
`;
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>\n${FIELD}`)
      .replace('#include <map_fragment>',detail+MAP)
      .replace('#include <normal_fragment_maps>',NORMAL)
      // A reused bare-metal rust mask otherwise changes the entire lighting
      // response in the same three-metre stamp, even after albedo/normal filtering.
      .replace('#include <metalnessmap_fragment>',`#include <metalnessmap_fragment>\nmetalnessFactor = ${bitumen?'0.0':'mix(0.035,metalnessFactor,0.03+0.09*roofResolvedDetail)'};`)
      .replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>\nroughnessFactor = max(roughnessFactor,${bitumen?'0.94':'0.76+0.14*(1.0-roofResolvedDetail)'});`);
  };
  material.customProgramCacheKey=()=>`${priorKey}:${GAME_ROOF_FILTER_VERSION}:${kind}`;material.needsUpdate=true;return true;
}
