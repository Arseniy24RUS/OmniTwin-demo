/** Small illustrative furnishings strictly contained by verified local source areas. */
import { mesh,quad,triangle,edgeBox,stableHash } from './geometry.mjs';
import { pointInRing } from '../geo/city-geography.mjs';

export const COURTYARD_LIMITS=Object.freeze({areas:256,attempts:4096,decorations:96,perArea:8,vertices:100000});
const GRID=18;
function segmentDistance(p,a,b){const x=b[0]-a[0],y=b[1]-a[1],d=x*x+y*y,t=d?Math.max(0,Math.min(1,((p[0]-a[0])*x+(p[1]-a[1])*y)/d)):0;return Math.hypot(p[0]-a[0]-t*x,p[1]-a[1]-t*y);}
function ringDistance(point,ring){return ring.reduce((distance,p,i)=>Math.min(distance,segmentDistance(point,p,ring[(i+1)%ring.length])),Infinity);}
function validArea(area){return area&&typeof area.key==='string'&&area.key.length>0&&['courtyard_hole','source_park','source_garden'].includes(area.kind)
  &&Array.isArray(area.sourceIds)&&area.sourceIds.length>0&&Array.isArray(area.rings)&&area.rings.length>0&&area.rings.length<=64
  &&area.rings.every(ring=>Array.isArray(ring)&&ring.length>=3&&ring.length<=4096&&ring.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)));}
function nearestEdgeAngle(point,ring){let nearest=Infinity,angle=0;for(let i=0;i<ring.length;i++){const a=ring[i],b=ring[(i+1)%ring.length],distance=segmentDistance(point,a,b);if(distance<nearest){nearest=distance;angle=Math.atan2(b[1]-a[1],b[0]-a[0]);}}return angle;}

function buildFurniture(placement){
  const c=Math.cos(placement.angle),s=Math.sin(placement.angle),point=([x,n])=>[placement.point[0]+x*c-n*s,placement.point[1]+x*s+n*c];
  const parts=new Map();
  const material=key=>{if(!parts.has(key)){const out=mesh(`${placement.id}:${key}`,key);Object.assign(out,{sourceIds:placement.sourceIds,provenance:'visual_synthesis',decorationId:placement.id,decorationPoint:placement.point});parts.set(key,out);}return parts.get(key);};
  const box=(key,a,b,y0,y1,depth)=>edgeBox(material(key),point(a),point(b),y0,y1,depth);
  const surface=(key,corners,y)=>quad(material(key),corners.map(p=>{const q=point(p);return[q[0],y,-q[1]];}));
  const pad=placement.kind==='bench'?[[-1.3,-.9],[1.3,-.9],[1.3,.9],[-1.3,.9]]:[[-1.1,-1.1],[1.1,-1.1],[1.1,1.1],[-1.1,1.1]];
  surface('paving',pad,.035);
  for(let i=0;i<4;i++)box('curb',pad[i],pad[(i+1)%4],.04,.13,.065);
  if(placement.kind==='bench'){
    box('timber',[-.95,.28],[.95,.28],.43,.52,.56);
    box('timber',[-.95,.32],[.95,.32],.67,.96,.055);
    for(const x of [-.70,.70])box('concrete',[x-.09,.19],[x+.09,.19],.04,.44,.38);
  }else{
    const frame=[[-.76,-.76],[.76,-.76],[.76,.76],[-.76,.76]];
    surface('trunk',frame,.48);
    for(let i=0;i<4;i++)box('concrete',frame[i],frame[(i+1)%4],.06,.57,.13);
    // Low ornamental shrubs, not additional observed or synthetic tree records.
    for(const [x,n] of [[-.35,-.25],[.32,-.25],[0,.32]]){
      const p=point([x,n]),r=.48,y=.92,h=.43;
      const vertices=[[p[0],y+h,-p[1]],[p[0]+r,y,-p[1]],[p[0],y,-p[1]-r],[p[0]-r,y,-p[1]],[p[0],y,-p[1]+r],[p[0],y-h,-p[1]]];
      for(let i=1;i<=4;i++){const j=i===4?1:i+1;triangle(material('leaves'),[vertices[0],vertices[i],vertices[j]]);triangle(material('leaves'),[vertices[5],vertices[j],vertices[i]],undefined,.85);}
    }
  }
  return [...parts.values()];
}

/** Caller supplies verified areas and conservative full-disk source exclusions. */
export function buildCourtyardDetails(areas,{boundsMeters,isBlocked,existingTrees=[],maxDecorations=96,seed='courtyard-details-v1'}={}){
  if(typeof isBlocked!=='function')throw new Error('Courtyard details require source exclusion checks');
  if(!Array.isArray(areas)||areas.some(area=>!validArea(area)))throw new Error('Invalid courtyard source area');
  if(!Array.isArray(boundsMeters)||boundsMeters.length!==4||!boundsMeters.every(Number.isFinite)||boundsMeters[0]>=boundsMeters[2]||boundsMeters[1]>=boundsMeters[3])throw new Error('Invalid courtyard bounds');
  if(!Number.isInteger(maxDecorations)||maxDecorations<0)throw new Error('Invalid courtyard detail cap');
  const cap=Math.min(maxDecorations,COURTYARD_LIMITS.decorations),meshes=[],placements=[];
  const diagnostics={attempts:0,sourceAreas:areas.length,eligibleAreas:0,rejectedByContainment:0,rejectedByExclusions:0,rejectedBySpacing:0,vertexCount:0,truncatedAreas:0,cap,representation:'visual_synthesis'};
  const unique=new Map();
  for(const area of areas){const key=JSON.stringify([area.kind,area.rings]);const previous=unique.get(key);if(!previous||area.key<previous.key)unique.set(key,area);}
  const ordered=[...unique.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  diagnostics.truncatedAreas=Math.max(0,ordered.length-COURTYARD_LIMITS.areas);
  const phase=[stableHash(`${seed}:east`)%18000/1000,stableHash(`${seed}:north`)%18000/1000];
  for(const area of ordered.slice(0,COURTYARD_LIMITS.areas)){
    if(placements.length>=cap||diagnostics.attempts>=COURTYARD_LIMITS.attempts)break;
    const ring=area.rings[0],minX=Math.max(boundsMeters[0],Math.min(...ring.map(p=>p[0]))),maxX=Math.min(boundsMeters[2],Math.max(...ring.map(p=>p[0]))),minY=Math.max(boundsMeters[1],Math.min(...ring.map(p=>p[1]))),maxY=Math.min(boundsMeters[3],Math.max(...ring.map(p=>p[1])));
    if(minX>=maxX||minY>=maxY)continue;
    diagnostics.eligibleAreas++;let count=0;
    for(let iy=Math.ceil((minY-phase[1])/GRID);iy<=Math.floor((maxY-phase[1])/GRID)&&count<COURTYARD_LIMITS.perArea&&placements.length<cap&&diagnostics.attempts<COURTYARD_LIMITS.attempts;iy++){
      for(let ix=Math.ceil((minX-phase[0])/GRID);ix<=Math.floor((maxX-phase[0])/GRID)&&count<COURTYARD_LIMITS.perArea&&placements.length<cap&&diagnostics.attempts<COURTYARD_LIMITS.attempts;ix++){
        diagnostics.attempts++;
        const point=[ix*GRID+phase[0],iy*GRID+phase[1]],radius=1.70;
        if(point[0]-radius<boundsMeters[0]||point[1]-radius<boundsMeters[1]||point[0]+radius>boundsMeters[2]||point[1]+radius>boundsMeters[3]
          ||!pointInRing(point,ring)||area.rings.slice(1).some(hole=>pointInRing(point,hole))||area.rings.some(r=>ringDistance(point,r)<radius+.35)){diagnostics.rejectedByContainment++;continue;}
        if(isBlocked(point,radius)){diagnostics.rejectedByExclusions++;continue;}
        if(existingTrees.some(tree=>Math.hypot(tree.point[0]-point[0],tree.point[1]-point[1])<tree.radiusMeters+radius+.4)
          ||placements.some(p=>Math.hypot(p.point[0]-point[0],p.point[1]-point[1])<p.radiusMeters+radius+2)){diagnostics.rejectedBySpacing++;continue;}
        const kind=count%2===0?'bench':'planter',angle=nearestEdgeAngle(point,ring),c=Math.cos(angle),s=Math.sin(angle);
        const half=kind==='bench'?[1.37,.97]:[1.17,1.17];
        const corners=[[-half[0],-half[1]],[half[0],-half[1]],[half[0],half[1]],[-half[0],half[1]]].map(([x,n])=>[point[0]+x*c-n*s,point[1]+x*s+n*c]);
        const placement={id:`courtyard-detail:${area.key}:${ix}:${iy}`,point,corners,angle,kind,radiusMeters:radius,sourceIds:[...area.sourceIds],areaKind:area.kind,provenance:'visual_synthesis'};
        const parts=buildFurniture(placement),vertices=parts.reduce((sum,m)=>sum+m.positions.length/3,0);
        if(diagnostics.vertexCount+vertices>COURTYARD_LIMITS.vertices)continue;
        meshes.push(...parts);placements.push(placement);diagnostics.vertexCount+=vertices;count++;
      }
    }
  }
  return{meshes,placements,diagnostics};
}
