import {Color,MeshStandardMaterial,Vector2} from 'three';
import {landCoverCoordinates} from './gameLandCoverMaterial';
import type {GameOrigin} from './cameraAdapter';
type Point=readonly [number,number];
const BASE=new Color('#a6a18f').toArray();
const mod=(v:number,p:number)=>((v%p)+p)%p;
const smooth=(a:number,b:number,x:number)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
function hash(x:number,z:number){let h=(Math.imul(mod(x,8192),1597334677)^Math.imul(mod(z,8192),3812015801))>>>0;h=Math.imul(h^(h>>>13),1274126177)>>>0;return(h&65535)/65535;}
/** Half-metre staggered pavers, 12mm joints. Decorative paving is synthesized;
 * a source building hole does not prove the surveyed courtyard surface class. */
export function sampleGameCourtyardFloor(p:Point,pixelFootprint:number,border=0){
  if(!p.every(Number.isFinite)||!Number.isFinite(pixelFootprint)||pixelFootprint<0||!Number.isFinite(border))throw Error('Invalid courtyard material coordinate');
  const row=Math.floor(p[1]/.5),x=p[0]+mod(row,2)*.25,cell=[Math.floor(x/.5),row],u=mod(x,.5),v=mod(p[1],.5),edge=Math.min(u,.5-u,v,.5-v);
  const aa=Math.max(.001,pixelFootprint*.65),resolved=1-smooth(.12,.42,pixelFootprint),joint=(1-smooth(.006-aa,.006+aa,edge))*resolved;
  const variation=(hash(cell[0]!,cell[1]!)-.5)*.018*resolved,shade=1-joint*.065+variation-border*.07;
  return{color:BASE.map(c=>c*shade) as [number,number,number],paverMeters:.5,roughness:.96};
}
export function createGameCourtyardGroundMaterial(){
  const material=new MeshStandardMaterial({color:0xffffff,roughness:.96,metalness:0}),offset={value:new Vector2()},scale={value:1};
  material.name='source-hole-metric-courtyard-paving';material.userData={provenance:'visual_synthesis',classification:'illustrative_paving_not_surveyed_surface',paverMeters:.5,jointMeters:.012,offset,scale};
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,{courtyardOffset:offset,courtyardScale:scale});
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute float courtyardBorder; varying float courtyardEdge; varying vec2 courtyardWorld; uniform vec2 courtyardOffset; uniform float courtyardScale;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\ncourtyardWorld=position.xz*courtyardScale+courtyardOffset; courtyardEdge=courtyardBorder;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',/* glsl */`#include <common>
varying vec2 courtyardWorld;varying float courtyardEdge;
float courtyardHash(vec2 cell){uvec2 p=uvec2(mod(cell,vec2(8192.0)));uint h=(p.x*1597334677u)^(p.y*3812015801u);h=(h^(h>>13u))*1274126177u;return float(h&65535u)/65535.0;}
`).replace('#include <color_fragment>',/* glsl */`#include <color_fragment>
float courtyardRow=floor(courtyardWorld.y/0.5);
vec2 courtyardP=vec2(courtyardWorld.x+mod(courtyardRow,2.0)*0.25,courtyardWorld.y);
vec2 courtyardCell=floor(courtyardP/0.5),courtyardUv=mod(courtyardP,0.5);
float courtyardDistance=min(min(courtyardUv.x,0.5-courtyardUv.x),min(courtyardUv.y,0.5-courtyardUv.y));
float courtyardFootprint=max(length(dFdx(courtyardWorld)),length(dFdy(courtyardWorld)));
float courtyardAa=max(0.001,max(fwidth(courtyardWorld.x),fwidth(courtyardWorld.y))*0.65);
float courtyardResolved=1.0-smoothstep(0.12,0.42,courtyardFootprint);
float courtyardJoint=(1.0-smoothstep(0.006-courtyardAa,0.006+courtyardAa,courtyardDistance))*courtyardResolved;
float courtyardShade=1.0-courtyardJoint*0.065+(courtyardHash(courtyardCell)-0.5)*0.018*courtyardResolved-courtyardEdge*0.07;
diffuseColor.rgb*=vec3(${BASE.join(',')})*courtyardShade;
`);
  };
  material.customProgramCacheKey=()=> 'source-hole-metric-courtyard-v1';return material;
}
export function updateGameCourtyardGroundMaterial(material:MeshStandardMaterial,origin:GameOrigin){
  const a=landCoverCoordinates([0,0],origin),b=landCoverCoordinates([1,0],origin);
  (material.userData.offset as {value:Vector2}).value.set(...a);(material.userData.scale as {value:number}).value=b[0]-a[0];
}
