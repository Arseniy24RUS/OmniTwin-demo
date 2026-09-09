import {Vector2,type Material,type MeshStandardMaterial} from 'three';
import {MINERAL_FACADE_PALETTES,type MineralFacadeFamily} from '../buildingFacadePolicy';

export const GAME_FACADE_GRAMMAR_VERSION='metric-facade-grammar-v1';
// Metres, not texture repeats. Existing window/reveal geometry remains the only
// aperture representation. Patterns are painted joints, courses and broad bays.
const PERIODS={panel:3.6,plaster:3.8,civic:3.6,neutral:3.8};
const mod=(x:number,p:number)=>((x%p)+p)%p;
const clamp=(x:number)=>Math.max(0,Math.min(1,x));
function line(x:number,period:number,width:number,pixel:number){
  const distance=Math.min(mod(x,period),period-mod(x,period));
  const aa=Math.max(.0005,pixel),resolved=clamp((width/2+aa/2-distance)/aa);
  const unresolved=clamp((pixel-period*.25)/(period*.5));
  return resolved*(1-unresolved)+width/period*unresolved;
}
/** CPU reference for the same bounded anti-aliased wall finish. */
export function sampleGameFacadeGrammar(family:MineralFacadeFamily,variant:number,metres:readonly [number,number],pixelFootprint:number){
  if(!Object.hasOwn(PERIODS,family)||!Number.isInteger(variant)||variant<0||variant>3
    ||metres.length!==2||!metres.every(Number.isFinite)||!Number.isFinite(pixelFootprint)||pixelFootprint<0)throw Error('Invalid facade grammar sample');
  const bay=PERIODS[family]+variant*.22,[x,y]=metres,vertical=line(x,bay,.04,pixelFootprint),horizontal=line(y,3,.04,pixelFootprint);
  const broad=line(x,bay*4,.48,pixelFootprint),band=line(y,3,.18,pixelFootprint);
  const shade=family==='panel'?1-.30*Math.max(vertical,horizontal)-.11*broad
    :family==='plaster'?1+.13*band-.10*broad
    :family==='civic'?1-.16*line(y,.5,.026,pixelFootprint)+.09*line(y,3,.20,pixelFootprint)-.08*broad
    :1-.16*horizontal-.14*line(x,bay*2,.24,pixelFootprint);
  return{shade,windowCoverage:0,bayMeters:bay,representation:'visual_synthesis' as const};
}

const FIELD=/* glsl */`
varying vec2 gameFacadeMetres;
varying float gameFacadeVariant;
varying float gameFacadeWall;
float gameFacadeLine(float x,float period,float width,float pixel){
  float position=mod(x,period);
  float distance=min(position,period-position);
  float aa=max(0.0005,pixel);
  float resolved=clamp((width*0.5+aa*0.5-distance)/aa,0.0,1.0);
  return mix(resolved,width/period,clamp((pixel-period*0.25)/(period*0.5),0.0,1.0));
}
`;

export function applyGameFacadeGrammar(input:Material):boolean{
  const material=input as MeshStandardMaterial,family=material.name as MineralFacadeFamily,repeat=material.userData.repeatMeters;
  if(!material.isMeshStandardMaterial||!material.map||!material.vertexColors||!Object.hasOwn(PERIODS,family)
    ||material.userData.sourceId!=='plastered_wall_02'||material.userData.facadeGrammar?.version===GAME_FACADE_GRAMMAR_VERSION
    ||!Array.isArray(repeat)||repeat.length!==2||repeat.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<.1||v>64)
    ||material.map.rotation!==0||material.map.repeat.x!==1||material.map.repeat.y!==1||material.map.offset.x!==0||material.map.offset.y!==0)return false;
  const prior=material.onBeforeCompile,priorKey=material.customProgramCacheKey(),palettes=MINERAL_FACADE_PALETTES[family];
  // Existing canonical vertex colours carry the finish. Ratios cancel the
  // compiler's independent floor shade, with no new per-vertex allocation.
  const classify=palettes.map((rgb,i)=>`{vec2 d=ratio-vec2(${(rgb[0]/rgb[1]).toFixed(7)},${(rgb[2]/rgb[1]).toFixed(7)});float error=dot(d,d);if(error<best){best=error;gameFacadeVariant=${i.toFixed(1)};}}`).join('\n');
  material.onBeforeCompile=(shader,renderer)=>{
    prior.call(material,shader,renderer);shader.uniforms.gameFacadeRepeatMeters={value:new Vector2(repeat[0],repeat[1])};
    shader.vertexShader=shader.vertexShader.replace('#include <common>',`#include <common>\nvarying vec2 gameFacadeMetres;\nvarying float gameFacadeVariant;\nvarying float gameFacadeWall;\nuniform vec2 gameFacadeRepeatMeters;`)
      .replace('#include <begin_vertex>',`#include <begin_vertex>\ngameFacadeMetres=uv*gameFacadeRepeatMeters;\ngameFacadeWall=1.0-smoothstep(0.10,0.25,abs(normal.y));\ngameFacadeVariant=0.0;\n#ifdef USE_COLOR\nvec2 ratio=color.rb/max(color.g,0.0001);float best=100.0;\n${classify}\n#endif`);
    const shade=family==='panel'?'1.0-0.30*max(vertical,horizontal)-0.11*broad'
      :family==='plaster'?'1.0+0.13*band-0.10*broad'
      :family==='civic'?'1.0-0.16*gameFacadeLine(y,0.5,0.026,pixel.y)+0.09*gameFacadeLine(y,3.0,0.20,pixel.y)-0.08*broad'
      :'1.0-0.16*horizontal-0.14*gameFacadeLine(x,bay*2.0,0.24,pixel.x)';
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>\n${FIELD}`)
      .replace('#include <color_fragment>',`#include <color_fragment>
vec2 pixel=fwidth(gameFacadeMetres);
float x=gameFacadeMetres.x,y=gameFacadeMetres.y;
float bay=${PERIODS[family].toFixed(1)}+floor(gameFacadeVariant+0.5)*0.22;
float vertical=gameFacadeLine(x,bay,0.04,pixel.x);
float horizontal=gameFacadeLine(y,3.0,0.04,pixel.y);
float broad=gameFacadeLine(x,bay*4.0,0.48,pixel.x);
float band=gameFacadeLine(y,3.0,0.18,pixel.y);
diffuseColor.rgb*=mix(1.0,${shade},clamp(gameFacadeWall,0.0,1.0));`);
  };
  material.customProgramCacheKey=()=>`${priorKey}:${GAME_FACADE_GRAMMAR_VERSION}:${family}`;
  material.userData.facadeGrammar={version:GAME_FACADE_GRAMMAR_VERSION,family,representation:'visual_synthesis',
    bayMeters:[PERIODS[family],PERIODS[family]+.66],floorCourseMeters:3,sourceUvUnchanged:true,windowCoverage:0,
    extraAttributes:0,extraDraws:0,extraTextureSamples:0,detailPolicy:'derivative_filtered_metric_joints_and_bays'};
  material.needsUpdate=true;return true;
}
