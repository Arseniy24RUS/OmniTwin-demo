import { ShapeUtils,Vector2 } from 'three';
import { projectLocal,signedArea,stableHash,mesh,quad,triangle,edgeBox } from './geometry.mjs';
import { facadeAppearance, tintMesh, roofFixtures,FACADE_GRAMMAR,BUILDING_DETAIL_LIMITS,windowSurround,balcony } from './building-details.mjs';

export function classifyFamily(b){const kind=String(b.sourceAttributes?.building??b.sourceClass??'yes'),material=String(b.sourceAttributes?.['building:material']??'');
  if(/industrial|warehouse|garages|garage/.test(kind))return'industrial';if(/school|hospital|university|civic|public|government|church/.test(kind))return'civic';
  if(/house|detached|cabin|wood/.test(kind)||/wood|timber/.test(material))return'timber';if(/glass|curtain_wall/.test(material)||kind==='office'&&b.heightM>=30)return'glass';if(/office|commercial|retail/.test(kind))return'plaster';
  if(/brick/.test(kind+material))return'brick';if(/plaster/.test(kind+material))return'plaster';if(/apartments|residential/.test(kind))return b.heightM>=15?'panel':'plaster';return'neutral';}
function roofStyle(b,family){const shape=b.sourceAttributes?.['roof:shape'];const pitched=['gabled','gable','hipped','pyramidal'].includes(shape)||!shape&&family==='timber';return {pitched,source:['gabled','gable','flat'].includes(shape)?'source_shape_with_derived_geometry':shape?'visual_synthesis_with_source_shape_hint':'visual_synthesis',material:/metal|sheet/.test(b.sourceAttributes?.['roof:material']??'')?'metal':pitched?'tile':family==='industrial'?'metal':'bitumen'};}
function clipHalf(poly,axis,cut,side){const result=[];for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],da=(a[axis]-cut)*side,db=(b[axis]-cut)*side;if(da>=-1e-8)result.push(a);if((da<0&&db>0)||(da>0&&db<0)){const t=da/(da-db);result.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}}return result;}
function windowFace(out,a,b,y0,y1,offset,shade=1){const length=Math.hypot(b[0]-a[0],b[1]-a[1]),dx=(b[1]-a[1])/length*offset,dn=-(b[0]-a[0])/length*offset;quad(out,[[a[0]+dx,y0,-a[1]-dn],[b[0]+dx,y0,-b[1]-dn],[b[0]+dx,y1,-b[1]-dn],[a[0]+dx,y1,-a[1]-dn]],shade);}
/** The surrounding source wall remains on its original plane. Only the
 * synthesized aperture is opened, so recessed glass is not hidden by a card. */
function wallBay(out,a,b,y0,y1,opening,shade){
  const face=(p,q,bottom,top)=>{if(top-bottom>.001&&Math.hypot(q[0]-p[0],q[1]-p[1])>.001)windowFace(out,p,q,bottom,top,0,shade);};
  if(!opening){face(a,b,y0,y1);return;}
  face(a,opening.a,y0,y1);face(opening.b,b,y0,y1);face(opening.a,opening.b,y0,opening.y0);face(opening.a,opening.b,opening.y1,y1);
}
export function buildBuilding(building,{origin,lod=0}={}){
  if(!origin||!building.id||!Number.isFinite(building.heightM)||building.heightM<=0)throw new Error('Invalid source building');
  const family=classifyFamily(building),roof=roofStyle(building,family),shell=mesh(`${building.id}:shell`,family,building.id),roofMesh=mesh(`${building.id}:roof`,roof.material,building.id),trim=mesh(`${building.id}:trim`,'trim',building.id),windows=mesh(`${building.id}:windows`,'windows',building.id),lightWindows=mesh(`${building.id}:windowLight`,'windowLight',building.id);
  const farWindows=mesh(`${building.id}:windowsFar`,'windows',building.id);
  const grammar=FACADE_GRAMMAR[family],plinth=mesh(`${building.id}:plinth`,'concrete',building.id),reveals=mesh(`${building.id}:windowReveals`,'trim',building.id),entrances=mesh(`${building.id}:entrances`,'doors',building.id),balconies=mesh(`${building.id}:balconies`,family==='brick'?'brick':'plaster',building.id);
  const polygons=building.footprint.type==='Polygon'?[building.footprint.coordinates]:building.footprint.coordinates;
  const base=Math.max(0,Number(building.sourceAttributes?.min_height)||0),height=building.heightM,roofRise=roof.pitched?Math.min(2.5,height*.2):0,eaves=height-roofRise;
  const floors=Math.max(1,Math.min(40,Number(building.levels)||Math.round((eaves-base)/3))),floorH=(eaves-base)/floors;
  const totalWindowSlots=polygons.reduce((sum,polygon)=>sum+polygon.reduce((n,ring)=>n+ring.slice(0,-1).reduce((count,p,i)=>{
    const a=projectLocal(p,origin),b=projectLocal(ring[i+1],origin);return count+Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/grammar.bayM))*floors;
  },0),0),0);
  const farWindowStride=Math.max(1,Math.ceil(totalWindowSlots/512));
  const deepWindowStride=Math.max(1,Math.ceil(totalWindowSlots/BUILDING_DETAIL_LIMITS.deepWindows));
  let windowsCount=0,ringCount=0,edgeCount=0,entranceCount=0,balconyCount=0,deepWindowCount=0,slotIndex=0,bandCount=0;const localPolygons=[],windowVariantCounts=[0,0,0];
  for(const polygon of polygons){
    const rings=polygon.map((r,i)=>{const points=r.slice(0,-1).map(p=>projectLocal(p,origin));if(points.length<3||points.some(p=>p.some(v=>!Number.isFinite(v))))throw new Error('Invalid source ring');if((signedArea(points)>0)!==(i===0))points.reverse();return points;});ringCount+=rings.length;
    localPolygons.push(rings);
    const entranceEdge=rings[0].reduce((best,p,i,r)=>Math.hypot(r[(i+1)%r.length][0]-p[0],r[(i+1)%r.length][1]-p[1])>Math.hypot(r[(best+1)%r.length][0]-r[best][0],r[(best+1)%r.length][1]-r[best][1])?i:best,0);
    const all=rings.flat(),min=[Math.min(...all.map(p=>p[0])),Math.min(...all.map(p=>p[1]))],max=[Math.max(...all.map(p=>p[0])),Math.max(...all.map(p=>p[1]))],axis=max[0]-min[0]<max[1]-min[1]?0:1,mid=(max[axis]+min[axis])/2,half=(max[axis]-min[axis])/2;
    const roofY=p=>eaves+(roofRise?roofRise*Math.max(0,1-Math.abs(p[axis]-mid)/Math.max(.01,half)):0);
    const faces=ShapeUtils.triangulateShape(rings[0].map(p=>new Vector2(...p)),rings.slice(1).map(r=>r.map(p=>new Vector2(...p))));
    for(const face of faces){let tri=face.map(i=>all[i]);if(signedArea(tri)<0)tri=tri.toReversed();for(const sub of roofRise?[clipHalf(tri,axis,mid,1),clipHalf(tri,axis,mid,-1)]:[tri])for(let i=1;i<sub.length-1;i++){const points=[sub[0],sub[i],sub[i+1]];triangle(roofMesh,points.map(p=>[p[0],roofY(p),-p[1]]),points.map(p=>[(p[0]-min[0])/Math.max(1,max[0]-min[0]),(p[1]-min[1])/Math.max(1,max[1]-min[1])]),.94);}}
    for(const ring of rings)for(let edge=0;edge<ring.length;edge++){
      const a=ring[edge],b=ring[(edge+1)%ring.length],length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(length<.1)continue;edgeCount++;
      const point=t=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
      const cols=Math.max(1,Math.ceil(length/grammar.bayM));
      if(lod)quad(shell,[[a[0],base,-a[1]],[b[0],base,-b[1]],[b[0],eaves,-b[1]],[a[0],eaves,-a[1]]],.96);
      for(let col=0;col<cols;col++)for(let floor=0;floor<floors;floor++){
        const p=point(col/cols),q=point((col+1)/cols),bottom=base+floor*floorH,top=base+(floor+1)*floorH;
        slotIndex++;let opening=null;
        if(!lod&&ring===rings[0]&&edge===entranceEdge&&col===Math.floor(cols/2)&&floor===0&&floorH>2.3&&entranceCount<4&&length/cols>1.8){
          const center=(col+.5)/cols,doorWidth=Math.min(family==='civic'?2:family==='industrial'?2.4:1.35,length/cols-.35),pa=point(center-doorWidth/(2*length)),pb=point(center+doorWidth/(2*length)),topDoor=Math.min(top-.2,base+2.45);
          windowSurround(reveals,pa,pb,base+.03,topDoor,.12,{frontM:.06,backM:-.18});windowFace(entrances,pa,pb,base+.03,topDoor,-.18);
          wallBay(shell,p,q,bottom,top,{a:pa,b:pb,y0:base+.03,y1:topDoor},.82);
          edgeBox(trim,point(center-(doorWidth+.5)/(2*length)),point(center+(doorWidth+.5)/(2*length)),topDoor+.08,Math.min(top-.02,topDoor+.22),.85,.025);
          edgeBox(plinth,point(center-(doorWidth+.35)/(2*length)),point(center+(doorWidth+.35)/(2*length)),base+.025,base+.13,.65);
          entranceCount++;continue;
        }
        if(length/cols>1.8&&floorH>1.8&&windowsCount<(lod?512:2400)&&(!lod||col%farWindowStride===0)){
          const windowSeed=stableHash(`${building.id}:${edge}:${floor}:${col}`),width=Math.min(length/cols-.3,grammar.windowM[0]+(grammar.windowM[1]-grammar.windowM[0])*(windowSeed%21)/20),halfWidth=width/(2*length),center=(col+.5)/cols,wp=point(center-halfWidth),wq=point(center+halfWidth),wa=point(center-halfWidth-.075/length),wb=point(center+halfWidth+.075/length),lit=windowSeed%17===0;
          const bottomWindow=bottom+Math.min(family==='industrial'?1.2:.9,floorH*.3),topWindow=Math.min(top-.4,bottomWindow+grammar.windowM[2]);
          const deep=!lod&&slotIndex%deepWindowStride===0&&deepWindowCount<BUILDING_DETAIL_LIMITS.deepWindows,backM=deep?-grammar.recessM:.045,frontM=deep?.045:.18;
          const variant=(stableHash(`${building.id}:window-pattern`)+col+Math.floor(floor/3))%3;
          if(!lod){windowSurround(reveals,wp,wq,bottomWindow,topWindow,grammar.frameM,{frontM,backM});windowVariantCounts[variant]++;}
          if(deep){opening={a:wp,b:wq,y0:bottomWindow,y1:topWindow};deepWindowCount++;}
          windowFace(lod?farWindows:lit?lightWindows:windows,wp,wq,bottomWindow,topWindow,lod?.06:backM,lit?1:[.78,.92,1][variant]);windowsCount++;
          if(!lod){
            const split=center+(variant===1?width/6/length:0);
            windowFace(reveals,point(split-.025/length),point(split+.025/length),bottomWindow,topWindow,frontM+.006,.9);
            if(variant!==0)windowFace(reveals,wp,wq,topWindow-.34,topWindow-.29,frontM+.008,.86);
          }
          if(!lod&&grammar.balconies&&ring===rings[0]&&floor>0&&col%4===1&&length/cols>2.2&&balconyCount<80){
            balcony(balconies,point(center-.85/length),point(center+.85/length),bottom);balconyCount++;
          }else if(!lod&&(['brick','civic','plaster'].includes(family)||deep))edgeBox(trim,wa,wb,bottomWindow-.10,bottomWindow-.02,.22,.015);
        }
        if(!lod)wallBay(shell,p,q,bottom,top,opening,floor===0?.82:.98);
      }
      if(roofRise){const cut=(mid-a[axis])/(b[axis]-a[axis]);const breaks=cut>0&&cut<1?[a,point(cut),b]:[a,b];for(let i=0;i<breaks.length-1;i++){const p=breaks[i],q=breaks[i+1];quad(shell,[[p[0],eaves,-p[1]],[q[0],eaves,-q[1]],[q[0],roofY(q),-q[1]],[p[0],roofY(p),-p[1]]]);}}
      if(!lod){edgeBox(plinth,a,b,base+.02,Math.min(eaves-.02,base+grammar.plinthM),.022);if(!roofRise){edgeBox(trim,a,b,height-.08,height+.31,.18,-.20);edgeBox(trim,a,b,height+.31,height+.39,.25,-.235);}else edgeBox(trim,a,b,eaves-.13,eaves,.14,-.04);
        if(ring===rings[0]&&floors>=3&&length>5&&bandCount<BUILDING_DETAIL_LIMITS.bands&&['civic','brick','plaster','panel'].includes(family)){
          const y=base+floorH;edgeBox(trim,a,b,y-.10,y+.03,family==='civic'?.14:.065,.015);bandCount++;
        }
      }
    }
  }
  const appearance=facadeAppearance(building.id);tintMesh(shell,appearance.facadeTint);
  const fixtures=!roof.pitched&&height>=6?roofFixtures(building.id,localPolygons,height,{family,lod}):null;
  const meshes=[shell,roofMesh,...(lod?[farWindows]:[trim,windows,lightWindows,plinth,reveals,entrances,balconies]),...(fixtures?[fixtures.mesh]:[])].filter(m=>m.indices.length);
  return {meshes,metadata:{canonicalId:building.id,osmId:building.osmId,aliases:building.aliases??[],name:building.name??null,sourceClass:building.sourceClass,sourceHeightM:height,heightQuality:building.heightQuality,baseHeightM:base,footprint:building.footprint,family,roofStyle:roof.pitched?'pitched':'flat_parapet',roofStyleProvenance:roof.source,detailRepresentation:'visual_synthesis',appearance:{...appearance,facadeGrammar:{family,version:3,representation:'visual_synthesis',entranceCount,balconyCount,deepWindowCount,bandCount,windowVariantCounts,windowProfile:{widthM:grammar.windowM.slice(0,2),heightM:grammar.windowM[2],recessM:grammar.recessM}},roofFixtures:fixtures?.placements??[]},windowCount:windowsCount,ringCount,edgeCount}};
}
