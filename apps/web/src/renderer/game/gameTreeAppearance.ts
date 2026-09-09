import {Float32BufferAttribute,SphereGeometry} from 'three';
import {createDeterministicRng} from '../rng';

const LEAF_COLORS=['#617b48','#6a8050','#536f43','#798858','#657b53','#526f50','#748a52','#64764b'] as const;

/** Illustrative canopy families, not inferred botanical species. */
export function gameTreeAppearance(id:string){
  const rng=createDeterministicRng(`tree-canopy-v2:${id}`);
  const family=rng()<.22?1:0;
  const scaleX=.78+rng()*.22,scaleZ=.72+rng()*.28,scaleY=.86+rng()*.14;
  return {family,scaleX,scaleY,scaleZ,offsetY:1-scaleY,
    leafColor:LEAF_COLORS[Math.floor(rng()*LEAF_COLORS.length)]!,brightness:.9+rng()*.13,
    trunkColor:rng()<.3?'#7a7565':'#675e4c'};
}

/** One continuous irregular volume; both families fit xz radius1 and y[0,1]. */
export function createGameTreeCanopy(family:0|1){
  const geometry=new SphereGeometry(1,12,8),positions=geometry.getAttribute('position');
  const colors:number[]=[];
  for(let i=0;i<positions.count;i++){
    const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i),u=(y+1)/2,angle=Math.atan2(z,x);
    const wave=.89+.06*Math.sin(3*angle+4*u)+.03*Math.sin(5*angle-7*u);
    const spread=family===0?.94:.61,bottom=family===0?.34:.21;
    positions.setXYZ(i,x*spread*wave,bottom+(1-bottom)*u+.015*Math.sin(3*angle)*Math.sin(Math.PI*u),z*spread*wave);
    const shade=Math.min(1,.86+.13*u+.025*Math.sin(4*angle+5*u));
    colors.push(shade,shade,shade);
  }
  geometry.deleteAttribute('uv');geometry.setAttribute('color',new Float32BufferAttribute(colors,3));
  geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();
  return geometry;
}
