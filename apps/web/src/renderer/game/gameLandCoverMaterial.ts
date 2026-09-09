import {MercatorCoordinate} from 'maplibre-gl';
import {Color,MeshStandardMaterial,Vector2} from 'three';
import {localToMercatorMatrix,type GameOrigin} from './cameraAdapter';
export const GAME_LAND_COVER_PERIOD_METERS=256;
/** Fixed city reference preserves physical scale when the floating origin moves. */
const METRES_PER_MERCATOR_UNIT=1/MercatorCoordinate.fromLngLat([0,55.1654]).meterInMercatorCoordinateUnits();
type Point=readonly [number,number];
const mod=(n:number,p:number)=>((n%p)+p)%p;
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const smooth=(a:number,b:number,x:number)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
const DARK=new Color('#667046').toArray(),LIGHT=new Color('#8b9160').toArray(),SOIL=new Color('#81745b').toArray();
function anchor(origin:GameOrigin){localToMercatorMatrix(origin);const p=MercatorCoordinate.fromLngLat([origin.longitude,origin.latitude]);return {
  offset:[mod(p.x*METRES_PER_MERCATOR_UNIT,256),mod(p.y*METRES_PER_MERCATOR_UNIT,256)] as [number,number],scale:p.meterInMercatorCoordinateUnits()*METRES_PER_MERCATOR_UNIT};}
export function landCoverCoordinates(localEastSouth:Point,origin:GameOrigin):[number,number]{if(!localEastSouth.every(Number.isFinite))throw Error('Invalid land cover coordinate');const a=anchor(origin);return[localEastSouth[0]*a.scale+a.offset[0],localEastSouth[1]*a.scale+a.offset[1]];}
function lattice(x:number,z:number,period:Point){const a=mod(x,period[0]),b=mod(z,period[1]);let h=(Math.imul(a,1597334677)^Math.imul(b,3812015801))>>>0;h=Math.imul(h^(h>>>13),1274126177)>>>0;return(h&65535)/65535;}
function noise(p:Point,period:Point):[number,number,number]{const x=Math.floor(p[0]),z=Math.floor(p[1]),f=p[0]-x,g=p[1]-z,u=f*f*(3-2*f),v=g*g*(3-2*g),du=6*f*(1-f),dv=6*g*(1-g);
  const a=lattice(x,z,period),b=lattice(x+1,z,period),c=lattice(x,z+1,period),d=lattice(x+1,z+1,period);
  return[mix(mix(a,b,u),mix(c,d,u),v),mix(b-a,d-c,v)*du,mix(c-a,d-b,u)*dv];}
/** CPU reference to the same periodic field; no time or camera state is retained. */
export function sampleGameLandCover(p:Point,footprint=0,detail=1){
  if(!p.every(Number.isFinite)||!Number.isFinite(footprint)||footprint<0||!Number.isFinite(detail)||detail<0||detail>1)throw Error('Invalid land cover sample');
  const macro=noise([p[0]/32,p[1]/32],[8,8]),tuft=noise(p,[256,256]),grain=noise([p[0]*8,p[1]*8],[2048,2048]);
  const blade=noise([(p[0]+p[1])*32,(p[1]-p[0])*8],[8192,2048]);
  const grainFade=(1-smooth(.04,.28,footprint))*detail,bladeFade=(1-smooth(.008,.08,footprint))*detail;
  const soil=.16*smooth(.48,.82,macro[0]*.65+tuft[0]*.35),shade=1+(tuft[0]-.5)*.2+(grain[0]-.5)*.15*grainFade+(blade[0]-.5)*.12*bladeFade;
  const color=DARK.map((v,i)=>mix(mix(v,LIGHT[i]!, .25+.6*macro[0]),SOIL[i]!,soil)*shade) as [number,number,number];
  const dx=tuft[1]*.006+grain[1]*8*.0025*grainFade+(blade[1]*32-blade[2]*8)*.001*bladeFade;
  const dz=tuft[2]*.006+grain[2]*8*.0025*grainFade+(blade[1]*32+blade[2]*8)*.001*bladeFade,length=Math.hypot(dx,1,dz);
  return{color,normal:[-dx/length,1/length,-dz/length] as [number,number,number],roughness:Math.max(.88,Math.min(.99,.93+(grain[0]-.5)*.055*grainFade+soil*.08))};
}
const rgb=(v:readonly number[])=>`vec3(${v.map(n=>n.toFixed(9)).join(',')})`;
const FIELD=/* glsl */`
varying vec2 landSurface;
uniform float landDetail;
float landHash(vec2 cell,vec2 period){
  uvec2 p=uvec2(mod(cell,period));
  uint h=(p.x*1597334677u)^(p.y*3812015801u);
  h=(h^(h>>13u))*1274126177u;
  return float(h&65535u)/65535.0;
}
vec3 landNoise(vec2 p,vec2 period){
  vec2 cell=floor(p),f=fract(p),u=f*f*(3.0-2.0*f),du=6.0*f*(1.0-f);
  float a=landHash(cell,period),b=landHash(cell+vec2(1.0,0.0),period);
  float c=landHash(cell+vec2(0.0,1.0),period),d=landHash(cell+vec2(1.0),period);
  return vec3(mix(mix(a,b,u.x),mix(c,d,u.x),u.y),mix(b-a,d-c,u.y)*du.x,mix(c-a,d-b,u.x)*du.y);
}
`;
const COLOR=/* glsl */`
vec3 landMacro=landNoise(landSurface/32.0,vec2(8.0));
vec3 landTuft=landNoise(landSurface,vec2(256.0));
float landFootprint=max(length(dFdx(landSurface)),length(dFdy(landSurface)));
float landGrainFade=(1.0-smoothstep(0.04,0.28,landFootprint))*landDetail;
float landBladeFade=(1.0-smoothstep(0.008,0.08,landFootprint))*landDetail;
vec3 landGrain=vec3(0.5,0.0,0.0),landBlade=vec3(0.5,0.0,0.0);
if(landGrainFade>0.0)landGrain=landNoise(landSurface*8.0,vec2(2048.0));
if(landBladeFade>0.0)landBlade=landNoise(vec2(landSurface.x+landSurface.y,landSurface.y-landSurface.x)*vec2(32.0,8.0),vec2(8192.0,2048.0));
float landSoil=0.16*smoothstep(0.48,0.82,landMacro.x*0.65+landTuft.x*0.35);
vec3 landColor=mix(mix(${rgb(DARK)},${rgb(LIGHT)},0.25+0.6*landMacro.x),${rgb(SOIL)},landSoil);
landColor*=1.0+(landTuft.x-0.5)*0.2+(landGrain.x-0.5)*0.15*landGrainFade+(landBlade.x-0.5)*0.12*landBladeFade;
diffuseColor.rgb*=landColor;
vec2 landHeightGradient=landTuft.yz*0.006+landGrain.yz*8.0*0.0025*landGrainFade
  +vec2(landBlade.y*32.0-landBlade.z*8.0,landBlade.y*32.0+landBlade.z*8.0)*0.001*landBladeFade;
float landRoughness=clamp(0.93+(landGrain.x-0.5)*0.055*landGrainFade+landSoil*0.08,0.88,0.99);
`;
export function createGameLandCoverMaterial(){
  const material=new MeshStandardMaterial({color:0xffffff,roughness:1,metalness:0}),offset={value:new Vector2()},scale={value:1},detail={value:1};
  material.name='source-metric-turf-soil';Object.assign(material.userData,{landOffset:offset,landScale:scale,landDetail:detail,provenance:'visual_synthesis',metresAtLatitude:55.1654,periodMeters:256});
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,{landOffset:offset,landScale:scale,landDetail:detail});
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nuniform vec2 landOffset; uniform float landScale; varying vec2 landSurface;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nlandSurface = position.xz * landScale + landOffset;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>\n${FIELD}`)
      .replace('#include <color_fragment>',`#include <color_fragment>\n${COLOR}`)
      .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor *= landRoughness;')
      .replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
        vec3 landEast=normalize((viewMatrix*vec4(1.0,0.0,0.0,0.0)).xyz);
        vec3 landSouth=normalize((viewMatrix*vec4(0.0,0.0,1.0,0.0)).xyz);
        normal=normalize(normal-landEast*landHeightGradient.x-landSouth*landHeightGradient.y);`);
  };
  material.customProgramCacheKey=()=> 'source-metric-turf-soil-v1';return material;
}
export function updateGameLandCoverMaterial(material:MeshStandardMaterial,origin:GameOrigin,tier:'low'|'medium'|'high'){
  const a=anchor(origin);(material.userData.landOffset as {value:Vector2}).value.set(...a.offset);
  (material.userData.landScale as {value:number}).value=a.scale;(material.userData.landDetail as {value:number}).value=tier==='low'?0:tier==='medium'?.7:1;
}
