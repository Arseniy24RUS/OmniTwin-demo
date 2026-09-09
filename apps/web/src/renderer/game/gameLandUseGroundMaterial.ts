import {Color,MeshStandardMaterial,Vector2} from 'three';
import type {GameOrigin} from './cameraAdapter';
import {landCoverCoordinates} from './gameLandCoverMaterial';
const BASE=new Color('#999480').toArray();
const mod=(v:number,p:number)=>((v%p)+p)%p,mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const smooth=(a:number,b:number,v:number)=>{const t=Math.max(0,Math.min(1,(v-a)/(b-a)));return t*t*(3-2*t);};
function hash(x:number,z:number,period:number){let h=(Math.imul(mod(x,period),1597334677)^Math.imul(mod(z,period),3812015801))>>>0;h=Math.imul(h^(h>>>13),1274126177)>>>0;return(h&65535)/65535;}
function noise(x:number,z:number,period:number){const ix=Math.floor(x),iz=Math.floor(z),fx=x-ix,fz=z-iz,u=fx*fx*(3-2*fx),v=fz*fz*(3-2*fz),du=6*fx*(1-fx),dv=6*fz*(1-fz),a=hash(ix,iz,period),b=hash(ix+1,iz,period),c=hash(ix,iz+1,period),d=hash(ix+1,iz+1,period);return[mix(mix(a,b,u),mix(c,d,u),v),mix(b-a,d-c,v)*du,mix(c-a,d-b,u)*dv];}
/** Neutral synthesis within a surveyed landuse polygon; never an asphalt claim.
 * Physical 1–32m variation plus filtered 8cm grain, seamless at 256 metres. */
export function sampleGameLandUseGround(p:readonly[number,number],footprint=0,detail=1){
 if(!p.every(Number.isFinite)||!Number.isFinite(footprint)||footprint<0||!Number.isFinite(detail)||detail<0||detail>1)throw Error('Invalid neutral landuse sample');
 const broad=noise(p[0]/32,p[1]/32,8),patch=noise((p[0]+p[1])/8,(p[1]-p[0])/8,32),soil=noise(p[0],p[1],256),grain=noise(p[0]*16,p[1]*16,4096),fade=(1-smooth(.025,.2,footprint))*detail;
 const shade=1+(broad[0]!-.5)*.18+(patch[0]!-.5)*.10+(soil[0]!-.5)*.065+(grain[0]!-.5)*.07*fade;
 const dx=soil[1]!*.003+grain[1]!*.006*fade,dz=soil[2]!*.003+grain[2]!*.006*fade,length=Math.hypot(dx,1,dz);
 return{color:BASE.map(v=>v*shade) as[number,number,number],normal:[-dx/length,1/length,-dz/length] as[number,number,number],roughness:.94+(grain[0]!-.5)*.04*fade};
}
const FIELD=/*glsl*/`
varying vec2 landUseSurface;
uniform float landUseDetail;
float groundHash(vec2 cell,float period){uvec2 p=uvec2(mod(cell,period));uint h=(p.x*1597334677u)^(p.y*3812015801u);h=(h^(h>>13u))*1274126177u;return float(h&65535u)/65535.0;}
vec3 groundNoise(vec2 p,float period){vec2 c=floor(p),f=fract(p),u=f*f*(3.0-2.0*f),d=6.0*f*(1.0-f);float a=groundHash(c,period),b=groundHash(c+vec2(1.0,0.0),period),e=groundHash(c+vec2(0.0,1.0),period),g=groundHash(c+vec2(1.0),period);return vec3(mix(mix(a,b,u.x),mix(e,g,u.x),u.y),mix(b-a,g-e,u.y)*d.x,mix(e-a,g-b,u.x)*d.y);}
`;
export function createGameLandUseGroundMaterial(){
 const material=new MeshStandardMaterial({color:0xffffff,roughness:1,metalness:0}),offset={value:new Vector2()},scale={value:1},detail={value:1};
 material.name='neutral-landuse-ground';Object.assign(material.userData,{provenance:'visual_synthesis',surfaceClassification:'unsurveyed_neutral_landuse_ground',landUseOffset:offset,landUseScale:scale,landUseDetail:detail,periodMeters:256});
 material.onBeforeCompile=shader=>{Object.assign(shader.uniforms,{landUseOffset:offset,landUseScale:scale,landUseDetail:detail});
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nuniform vec2 landUseOffset;uniform float landUseScale;varying vec2 landUseSurface;')
   .replace('#include <begin_vertex>','#include <begin_vertex>\nlandUseSurface=position.xz*landUseScale+landUseOffset;');
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>\n${FIELD}`)
   .replace('#include <color_fragment>',`#include <color_fragment>
vec3 groundBroad=groundNoise(landUseSurface/32.0,8.0);
vec3 groundPatch=groundNoise(vec2(landUseSurface.x+landUseSurface.y,landUseSurface.y-landUseSurface.x)/8.0,32.0);
vec3 groundSoil=groundNoise(landUseSurface,256.0);
float groundFootprint=max(length(dFdx(landUseSurface)),length(dFdy(landUseSurface)));
float groundFade=(1.0-smoothstep(0.025,0.2,groundFootprint))*landUseDetail;
vec3 groundGrain=vec3(0.5,0.0,0.0);if(groundFade>0.0)groundGrain=groundNoise(landUseSurface*16.0,4096.0);
float groundShade=1.0+(groundBroad.x-0.5)*0.18+(groundPatch.x-0.5)*0.10+(groundSoil.x-0.5)*0.065+(groundGrain.x-0.5)*0.07*groundFade;
diffuseColor.rgb*=vec3(${BASE.join(',')})*groundShade;
vec2 groundSlope=groundSoil.yz*0.003+groundGrain.yz*0.006*groundFade;
`)
   .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor*=0.94+(groundGrain.x-0.5)*0.04*groundFade;')
   .replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
normal=normalize(normal-normalize((viewMatrix*vec4(1.0,0.0,0.0,0.0)).xyz)*groundSlope.x-normalize((viewMatrix*vec4(0.0,0.0,1.0,0.0)).xyz)*groundSlope.y);`);
 };material.customProgramCacheKey=()=> 'neutral-source-landuse-ground-v1';return material;
}
export function updateGameLandUseGroundMaterial(material:MeshStandardMaterial,origin:GameOrigin,tier:'low'|'medium'|'high'){
 const a=landCoverCoordinates([0,0],origin),b=landCoverCoordinates([1,0],origin);
 (material.userData.landUseOffset as{value:Vector2}).value.set(...a);(material.userData.landUseScale as{value:number}).value=b[0]-a[0];(material.userData.landUseDetail as{value:number}).value=tier==='low'?0:tier==='medium'?.7:1;
}
