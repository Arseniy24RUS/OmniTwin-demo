import { pointInRing } from '../geo/city-geography.mjs';
import { stableHash, mesh, edgeBox,quad,triangle,signedArea } from './geometry.mjs';

export const FACADE_GRAMMAR=Object.freeze({
  panel:{bayM:3.6,frameM:.09,plinthM:.65,balconies:true,windowM:[1.2,1.4,1.4],recessM:.16},brick:{bayM:3.4,frameM:.10,plinthM:.55,balconies:false,windowM:[1.15,1.4,1.6],recessM:.22},
  plaster:{bayM:3.8,frameM:.09,plinthM:.7,balconies:true,windowM:[1.2,1.45,1.5],recessM:.18},glass:{bayM:3.2,frameM:.055,plinthM:.3,balconies:false,windowM:[1.7,2.1,2.0],recessM:.12},
  industrial:{bayM:5.6,frameM:.055,plinthM:.8,balconies:false,windowM:[1.8,2.5,1.1],recessM:.14},civic:{bayM:3.6,frameM:.14,plinthM:.85,balconies:false,windowM:[1.5,1.85,1.75],recessM:.24},
  timber:{bayM:3.2,frameM:.08,plinthM:.45,balconies:false,windowM:[.9,1.15,1.25],recessM:.12},neutral:{bayM:3.8,frameM:.075,plinthM:.6,balconies:false,windowM:[1.15,1.4,1.4],recessM:.16},
});
export const BUILDING_DETAIL_LIMITS=Object.freeze({deepWindows:48,bands:64,roofNear:24,roofFar:8,roofCandidates:512,roofTrianglesNear:2400,roofTrianglesFar:240});

const BAY_PATTERNS={
  panel:{widths:[1.3,2.1,1.3,.78,1.8,1.3],weights:[1,1.12,1,.66,1.12,1],stair:3},
  brick:{widths:[1.2,1.55,1.2,1.05],weights:[1,1.08,1,.88],stair:-1},
  plaster:{widths:[1.4,1.95,1.4,.82,1.7],weights:[1,1.14,1,.7,1.08],stair:3},
  glass:{widths:[2.1,2.3,2.1],weights:[1,1,1],stair:-1},
  industrial:{widths:[3,3,1.4],weights:[1.1,1.1,.8],stair:-1},
  civic:{widths:[1.8,1.8,1.3,1.8,1.8],weights:[1,1,.84,1,1],stair:-1},
  timber:{widths:[1,1.25,1],weights:[1,1.12,1],stair:-1},
  neutral:{widths:[1.2,1.75,1.2],weights:[1,1.12,1],stair:-1},
};
export function facadeLayoutProfile(id,family){
  const pattern=BAY_PATTERNS[family],variant=stableHash(`facade-layout:${id}`)%3;
  return{version:4,representation:'visual_synthesis',variant,pattern:pattern.widths,
    bayM:FACADE_GRAMMAR[family].bayM+[0,.28,-.18][variant],weights:pattern.weights,stair:pattern.stair};
}
/** Nonuniform room/stair bays fill the exact source edge without extending it. */
export function facadeEdgeBays(profile,length){
  const count=Math.max(1,Math.ceil(length/profile.bayM)),offset=profile.variant,weights=Array.from({length:count},(_,i)=>profile.weights[(i+offset)%profile.weights.length]),sum=weights.reduce((a,b)=>a+b,0);
  let cursor=0;return weights.map((weight,i)=>{const start=cursor;cursor+=weight/sum;const index=(i+offset)%profile.pattern.length;
    return{start,end:i===count-1?1:cursor,widthM:profile.pattern[index],stair:count>=5&&index===profile.stair,index};});
}

/** Three exposed faces, with no hidden bottom/end caps along continuous roofs. */
export function coarseParapet(out,a,b,height){
  const length=Math.hypot(b[0]-a[0],b[1]-a[1]),normal=[(b[1]-a[1])/length,-(b[0]-a[0])/length];
  const p=(q,y,offset)=>[q[0]+normal[0]*offset,y,-q[1]-normal[1]*offset];
  quad(out,[p(a,height,-.015),p(b,height,-.015),p(b,height+.28,-.015),p(a,height+.28,-.015)],.82);
  quad(out,[p(a,height+.28,-.015),p(b,height+.28,-.015),p(b,height+.28,-.20),p(a,height+.28,-.20)],1);
  quad(out,[p(a,height+.28,-.20),p(b,height+.28,-.20),p(b,height,-.20),p(a,height,-.20)],.65);
}

/** Physical reveal behind a shallow projecting window surround. The glass is
 * recessed relative to the frame while remaining ahead of the source wall. */
export function windowSurround(out,a,b,y0,y1,width=.09,{frontM=.18,backM=.045}={}){
  const length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(length<.1)return;
  const along=[(b[0]-a[0])/length,(b[1]-a[1])/length],normal=[along[1],-along[0]];
  const p=(u,y,depth)=>[a[0]+along[0]*u+normal[0]*depth,y,-a[1]-along[1]*u-normal[1]*depth];
  const corners=(pad,depth)=>[p(-pad,y0-pad,depth),p(length+pad,y0-pad,depth),p(length+pad,y1+pad,depth),p(-pad,y1+pad,depth)];
  const outer=corners(width,frontM),front=corners(0,frontM),back=corners(0,backM);
  for(let i=0;i<4;i++){const n=(i+1)%4;quad(out,[outer[i],outer[n],front[n],front[i]],.96);quad(out,[front[i],front[n],back[n],back[i]],i===2?.66:.8);}
}

export function balcony(out,a,b,floorY){
  edgeBox(out,a,b,floorY+.04,floorY+.18,.72,.025);
  edgeBox(out,a,b,floorY+.18,floorY+1.03,.065,.68);
  const len=Math.hypot(b[0]-a[0],b[1]-a[1]),t=[(b[0]-a[0])/len,(b[1]-a[1])/len];
  for(const q of [a,b])edgeBox(out,[q[0]-t[0]*.03,q[1]-t[1]*.03],[q[0]+t[0]*.03,q[1]+t[1]*.03],floorY+.18,floorY+1.03,.65,.025);
}

// Multipliers for authored albedo, not measurements of the source building.
const TINTS = [[1,.95,.86],[.84,.91,1],[.88,1,.90],[1,.83,.73],[.94,.87,.96],[1,1,1]];
export function facadeAppearance(id) {
  return {representation:'visual_synthesis',palette:'muted-facades-v1',
    facadeTint:[...TINTS[stableHash(`facade:${id}`)%TINTS.length]]};
}
export function tintMesh(out,tint) {
  for(let i=0;i<out.colors.length;i++)out.colors[i]*=tint[i%3];
}
function edgeDistance(p,a,b) {
  const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy;
  const t=den?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)):0;
  return Math.hypot(p[0]-a[0]-dx*t,p[1]-a[1]-dy*t);
}

/** Small visual rooftop fixtures. A clearance disk contains each entire box,
 * so no edge can bridge a concave boundary or a real courtyard opening. */
export function roofFixtures(id,polygons,height,{family='neutral',lod=0}={}) {
  const out=mesh(`${id}:roofFixtures`,'metal',id),placements=[],candidates=[],L=BUILDING_DETAIL_LIMITS;
  const large=family==='industrial',envelopeW=large?5.2:3.8,envelopeD=large?3.4:2.8,radius=Math.hypot(envelopeW,envelopeD)/2;
  const area=polygons.reduce((sum,rings)=>sum+Math.max(0,Math.abs(signedArea(rings[0]))-rings.slice(1).reduce((n,r)=>n+Math.abs(signedArea(r)),0)),0);
  const areaPerGroupM2={panel:180,plaster:240,civic:280,industrial:420,neutral:320,brick:240,glass:280,timber:320}[family]??320;
  const target=Math.min(L.roofNear,Math.max(1,Math.ceil(area/areaPerGroupM2))),phase=stableHash(`rooftop:${id}`)%127;
  let attempts=0;
  const radical=(n,base)=>{let value=0,p=1/base;while(n){value+=(n%base)*p;n=Math.floor(n/base);p/=base;}return value;};
  for(const rings of polygons){
    const outer=rings[0],xs=outer.map(p=>p[0]),ys=outer.map(p=>p[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    for(let i=1;i<=256&&attempts<L.roofCandidates;i++,attempts++){
      const center=[minX+radical(i+phase,2)*(maxX-minX),minY+radical(i+phase,3)*(maxY-minY)];
      if(!pointInRing(center,outer)||rings.slice(1).some(r=>pointInRing(center,r)))continue;
      if(rings.some(r=>r.some((p,j)=>edgeDistance(center,p,r[(j+1)%r.length])<radius+1.5)))continue;
      candidates.push(center);
    }
  }
  // Farthest-first selection covers the whole roof instead of exhausting the
  // object cap in its first rows. Coarse LOD is the same stable prefix.
  const selected=[];
  while(selected.length<target&&candidates.length){let best=0,score=-Infinity;
    for(let i=0;i<candidates.length;i++){const p=candidates[i],distance=selected.length?Math.min(...selected.map(q=>Math.hypot(p[0]-q[0],p[1]-q[1]))):0;if(distance>score){score=distance;best=i;}}
    if(selected.length&&score<8)break;selected.push(candidates.splice(best,1)[0]);
  }
  const corners=(x,y,w,d)=>[[x-w/2,y-d/2],[x+w/2,y-d/2],[x+w/2,y+d/2],[x-w/2,y+d/2]];
  const box=(x,y,w,d,y0,y1)=>edgeBox(out,[x-w/2,y+d/2],[x+w/2,y+d/2],y0,y1,d);
  const fan=(x,y,z,r)=>{for(let i=0;i<8;i++){const a=i*Math.PI/4,b=(i+1)*Math.PI/4;triangle(out,[[x,z,-y],[x+Math.cos(a)*r,z,-y-Math.sin(a)*r],[x+Math.cos(b)*r,z,-y-Math.sin(b)*r]],undefined,.32);}};
  const kinds=['air_handler','access_headhouse','vent_cluster','duct_bank'];
  for(const [i,[x,y]]of selected.slice(0,lod?L.roofFar:L.roofNear).entries()){
    const variant=(stableHash(`roof-kind:${id}`)+i)%4,kind=kinds[variant],w=large?4.4:variant===1?3:2.8,d=large?2.6:variant===1?2.1:1.8,h=variant===1?1.65:variant===2?1.3:.85;
    if(lod){
      box(x,y,w,d,height+.035,height+h);
      quad(out,[[x-w/2-.08,height+h+.10,-y+d/2+.08],[x+w/2+.08,height+h+.10,-y+d/2+.08],[x+w/2+.08,height+h+.10,-y-d/2-.08],[x-w/2-.08,height+h+.10,-y-d/2-.08]],.86);
      if(variant===0){fan(x-w*.24,y,height+h+.105,.42);fan(x+w*.24,y,height+h+.105,.42);}
      else if(variant===1)quad(out,[[x-.43,height+.15,-y+d/2+.005],[x+.43,height+.15,-y+d/2+.005],[x+.43,height+1.5,-y+d/2+.005],[x-.43,height+1.5,-y+d/2+.005]],.42);
      else for(let bar=0;bar<3;bar++){const z=height+.30+bar*.13;quad(out,[[x-w*.35,z,-y+d/2+.005],[x+w*.35,z,-y+d/2+.005],[x+w*.35,z+.035,-y+d/2+.005],[x-w*.35,z+.035,-y+d/2+.005]],.45);}
    }
    else{
      box(x,y,w+.3,d+.3,height+.025,height+.15);
      if(variant===2){for(const dx of [-.65,.65]){box(x+dx,y,.55,.7,height+.15,height+h);box(x+dx,y,.8,.95,height+h,height+h+.1);}}
      else{box(x,y,w,d,height+.15,height+h);box(x,y,w+.16,d+.16,height+h,height+h+.10);
        if(variant===0){fan(x-w*.24,y,height+h+.105,.42);fan(x+w*.24,y,height+h+.105,.42);}
        if(variant===1)quad(out,[[x-.43,height+.15,-y+d/2+.005],[x+.43,height+.15,-y+d/2+.005],[x+.43,height+1.5,-y+d/2+.005],[x-.43,height+1.5,-y+d/2+.005]],.42);
        else for(let bar=0;bar<3;bar++){const z=height+.35+bar*.13;quad(out,[[x-w*.35,z,-y+d/2+.005],[x+w*.35,z,-y+d/2+.005],[x+w*.35,z+.035,-y+d/2+.005],[x-w*.35,z+.035,-y+d/2+.005]],.5);}}
    }
    placements.push({center:[x,y],corners:corners(x,y,w,d),envelopeCorners:corners(x,y,envelopeW,envelopeD),topM:height+h+.11,kind,representation:'visual_synthesis'});
  }
  if(out.indices.length/3>(lod?L.roofTrianglesFar:L.roofTrianglesNear))throw Error('Roof detail triangle budget exceeded');
  return {mesh:out,placements,policy:{version:2,representation:'visual_synthesis',areaPerGroupM2,sourceRoofAreaM2:area,
    maximumNear:L.roofNear,maximumFar:L.roofFar,minimumSeparationM:8,footprintEdgeClearanceM:1.5}};
}
