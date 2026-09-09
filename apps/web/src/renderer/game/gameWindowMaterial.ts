import {type Material,type MeshStandardMaterial} from 'three';

export const GAME_WINDOW_FINISH_VERSION='quiet-glazing-v1';
export interface GameWindowDaylight {value:number}
/** Authored room shading in the compiler's existing per-window UVs. */
export function sampleGameWindowFinish(u:number,v:number,daylight:number){
  if(![u,v,daylight].every(Number.isFinite)||daylight<0||daylight>1)throw Error('Invalid window finish sample');
  const x=Math.max(0,Math.min(1,u)),y=Math.max(0,Math.min(1,v));
  const t=Math.max(0,Math.min(1,Math.min(x,1-x,y,1-y)/.18));
  return {roomShade:(.62+.38*t*t*(3-2*t))*(1-.28*y),emissionScale:1-.99*daylight};
}

/** Uses the existing shared sun bucket. Light windows read as muted interiors
 * during daylight and become warm after sunset; no independent phase or RAF.
 * Glass/frames and canonical triangle ownership remain in the source GLB. */
export function applyGameWindowMaterial(input:Material,daylight:GameWindowDaylight):boolean{
  const material=input as MeshStandardMaterial;
  if(!material.isMeshStandardMaterial||!['windows','windowLight'].includes(material.name)||material.map
    ||material.userData.representation!=='visual_synthesis'||material.userData.windowFinish?.version===GAME_WINDOW_FINISH_VERSION)return false;
  if(!Number.isFinite(daylight.value)||daylight.value<0||daylight.value>1)throw Error('Invalid shared window daylight');
  const lit=material.name==='windowLight',prior=material.onBeforeCompile,key=material.customProgramCacheKey();
  material.color.set(lit?'#716952':'#58676d');
  material.roughness=.32;material.metalness=.08;material.envMapIntensity=.8;
  if(lit){material.emissive.set('#ffd29a');material.emissiveIntensity=.7;}
  material.onBeforeCompile=(shader,renderer)=>{
    prior.call(material,shader,renderer);shader.uniforms.gameWindowDaylight=daylight;
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec2 gameWindowUv;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\ngameWindowUv=uv;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec2 gameWindowUv;\nuniform float gameWindowDaylight;')
      .replace('#include <color_fragment>',`#include <color_fragment>
vec2 roomUv=clamp(gameWindowUv,0.0,1.0);
float roomEdge=min(min(roomUv.x,1.0-roomUv.x),min(roomUv.y,1.0-roomUv.y));
float roomShade=(0.62+0.38*smoothstep(0.0,0.18,roomEdge))*(1.0-0.28*roomUv.y);
diffuseColor.rgb*=roomShade;`)
      .replace('#include <emissivemap_fragment>',`#include <emissivemap_fragment>\ntotalEmissiveRadiance*=mix(1.0,0.01,clamp(gameWindowDaylight,0.0,1.0))*roomShade;`);
  };
  material.customProgramCacheKey=()=>`${key}:${GAME_WINDOW_FINISH_VERSION}:${lit?'lit':'glass'}`;
  material.userData.windowFinish={version:GAME_WINDOW_FINISH_VERSION,representation:'visual_synthesis',daylightSource:'existing_game_sun_bucket',
    sourceWindowUvUnchanged:true,extraTextureSamples:0,extraDraws:0};
  material.needsUpdate=true;return true;
}
