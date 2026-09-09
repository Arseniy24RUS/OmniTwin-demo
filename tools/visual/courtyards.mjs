import { ShapeUtils,Vector2 } from 'three';
import { projectLocal,mesh,triangle,stableHash,signedArea } from './geometry.mjs';
import { pointInRing } from '../geo/city-geography.mjs';

/** Sparse illustrative vegetation only inside actual enclosed source courtyards. */
export function buildCourtyards(buildings,{origin,lod=0}){
  const paving=mesh('courtyards:paving','paving'),grass=mesh('courtyards:grass','grass'),trunks=mesh('courtyards:trunks','trunk'),leaves=mesh('courtyards:leaves','leaves');let trees=0,courtyards=0;
  for(const building of buildings){const polys=building.footprint.type==='Polygon'?[building.footprint.coordinates]:building.footprint.coordinates;for(const p of polys)for(const sourceHole of p.slice(1)){
    const ring=sourceHole.slice(0,-1).map(pt=>projectLocal(pt,origin));if(signedArea(ring)<0)ring.reverse();if(Math.abs(signedArea(ring))<40)continue;courtyards++;
    const faces=ShapeUtils.triangulateShape(ring.map(v=>new Vector2(...v)),[]);const surface=stableHash(building.id)%3===0?paving:grass;
    for(const face of faces){const t=face.map(i=>ring[i]);if(signedArea(t)<0)t.reverse();triangle(surface,t.map(v=>[v[0],.012,-v[1]]),[[0,0],[1,0],[.5,1]],.96);}
    if(lod)continue;const xs=ring.map(p=>p[0]),ys=ring.map(p=>p[1]);let count=0;
    for(let n=Math.min(...ys)+7;n<Math.max(...ys)-5&&count<6;n+=14)for(let e=Math.min(...xs)+7;e<Math.max(...xs)-5&&count<6;e+=14){if(!pointInRing([e,n],ring)||stableHash(`${building.id}:${e.toFixed(1)}:${n.toFixed(1)}`)%3!==0)continue;
      const clearance=ring.reduce((min,p,i)=>{const q=ring[(i+1)%ring.length],dx=q[0]-p[0],dy=q[1]-p[1],t=Math.max(0,Math.min(1,((e-p[0])*dx+(n-p[1])*dy)/(dx*dx+dy*dy)));return Math.min(min,Math.hypot(e-p[0]-dx*t,n-p[1]-dy*t));},Infinity);if(clearance<4)continue;
      const h=4.6+(stableHash(`${building.id}:${count}`)%16)/10,r=1.9;
      for(let side=0;side<6;side++){const a=side*Math.PI/3,b=(side+1)*Math.PI/3,pa=[e+Math.cos(a)*r,h*.7,-n-Math.sin(a)*r],pb=[e+Math.cos(b)*r,h*.7,-n-Math.sin(b)*r];triangle(leaves,[[e,h+1.4,-n],pa,pb],[[.5,0],[0,1],[1,1]],.86+side*.018);triangle(leaves,[[e,2.4,-n],pb,pa],[[.5,0],[1,1],[0,1]],.75);const ta=[e+Math.cos(a)*.16,0,-n-Math.sin(a)*.16],tb=[e+Math.cos(b)*.16,0,-n-Math.sin(b)*.16];triangle(trunks,[ta,tb,[tb[0],h*.8,tb[2]]]);triangle(trunks,[ta,[tb[0],h*.8,tb[2]],[ta[0],h*.8,ta[2]]]);}
      count++;trees++;
    }
  }}
  return {meshes:[paving,grass,trunks,leaves].filter(m=>m.indices.length),diagnostics:{courtyards,trees,placement:'visual_synthesis_inside_verified_source_holes',observedTrees:false}};
}
