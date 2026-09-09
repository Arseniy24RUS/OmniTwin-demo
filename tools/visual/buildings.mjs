import { ShapeUtils,Vector2 } from 'three';
import { projectLocal,signedArea,stableHash,mesh,quad,triangle,edgeBox } from './geometry.mjs';
import { facadeAppearance, tintMesh, roofFixtures,FACADE_GRAMMAR,BUILDING_DETAIL_LIMITS,windowSurround,balcony,facadeLayoutProfile,facadeEdgeBays,coarseParapet } from './building-details.mjs';

export function classifyFamily(b){const kind=String(b.sourceAttributes?.building??b.sourceClass??'yes'),material=String(b.sourceAttributes?.['building:material']??'');
  if(/industrial|warehouse|garages|garage/.test(kind))return'industrial';if(/school|hospital|university|civic|public|government|church/.test(kind))return'civic';
  if(/house|detached|cabin|wood/.test(kind)||/wood|timber/.test(material))return'timber';if(/glass|curtain_wall/.test(material)||kind==='office'&&b.heightM>=30)return'glass';if(/office|commercial|retail/.test(kind))return'plaster';
  if(/brick/.test(kind+material))return'brick';if(/plaster/.test(kind+material))return'plaster';if(/apartments|residential/.test(kind))return b.heightM>=15?'panel':'plaster';return'neutral';}
function roofStyle(b,family){const shape=b.sourceAttributes?.['roof:shape'];const pitched=['gabled','gable','hipped','pyramidal'].includes(shape)||!shape&&family==='timber';return {pitched,source:['gabled','gable','flat'].includes(shape)?'source_shape_with_derived_geometry':shape?'visual_synthesis_with_source_shape_hint':'visual_synthesis',material:/metal|sheet/.test(b.sourceAttributes?.['roof:material']??'')?'metal':pitched?'tile':family==='industrial'?'metal':'bitumen'};}
function clipHalf(poly,axis,cut,side){const result=[];for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],da=(a[axis]-cut)*side,db=(b[axis]-cut)*side;if(da>=-1e-8)result.push(a);if((da<0&&db>0)||(da>0&&db<0)){const t=da/(da-db);result.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}}return result;}
function windowFace(out,a,b,y0,y1,offset,shade=1){const length=Math.hypot(b[0]-a[0],b[1]-a[1]),dx=(b[1]-a[1])/length*offset,dn=-(b[0]-a[0])/length*offset;quad(out,[[a[0]+dx,y0,-a[1]-dn],[b[0]+dx,y0,-b[1]-dn],[b[0]+dx,y1,-b[1]-dn],[a[0]+dx,y1,-a[1]-dn]],shade);}
/** The surrounding source wall remains on its original plane. Only the
 * synthesized aperture is opened, so recessed glass is not hidden by a card. */
function wallFace(out,a,b,y0,y1,openings,shade){
  const length=Math.hypot(b[0]-a[0],b[1]-a[1]);
  if(!openings.length){windowFace(out,a,b,y0,y1,0,shade);return;}
  const station=p=>((p[0]-a[0])*(b[0]-a[0])+(p[1]-a[1])*(b[1]-a[1]))/length;
  const outer=[[0,y0],[length,y0],[length,y1],[0,y1]],holes=openings.map(o=>[[station(o.a),o.y0],[station(o.a),o.y1],[station(o.b),o.y1],[station(o.b),o.y0]]);
  const all=[...outer,...holes.flat()],faces=ShapeUtils.triangulateShape(outer.map(p=>new Vector2(...p)),holes.map(r=>r.map(p=>new Vector2(...p))));
  const point=([u,y])=>[a[0]+(b[0]-a[0])*u/length,y,-a[1]-(b[1]-a[1])*u/length];
  for(const face of faces)triangle(out,face.map(i=>point(all[i])),undefined,shade);
}
export function buildBuilding(building,{origin,lod=0}={}){
  if(!origin||!building.id||!Number.isFinite(building.heightM)||building.heightM<=0)throw new Error('Invalid source building');
  const family=classifyFamily(building),roof=roofStyle(building,family),shell=mesh(`${building.id}:shell`,family,building.id),roofMesh=mesh(`${building.id}:roof`,roof.material,building.id),trim=mesh(`${building.id}:trim`,'trim',building.id),windows=mesh(`${building.id}:windows`,'windows',building.id),lightWindows=mesh(`${building.id}:windowLight`,'windowLight',building.id);
  const farWindows=mesh(`${building.id}:windowsFar`,'windows',building.id);
  const grammar=FACADE_GRAMMAR[family],layout=facadeLayoutProfile(building.id,family),plinth=mesh(`${building.id}:plinth`,'concrete',building.id),reveals=mesh(`${building.id}:windowReveals`,'trim',building.id),entrances=mesh(`${building.id}:entrances`,'doors',building.id),balconies=mesh(`${building.id}:balconies`,family==='brick'?'brick':'plaster',building.id);
  const shopSource=/^(commercial|retail)$/.test(String(building.sourceAttributes?.building??building.sourceClass));
  const polygons=building.footprint.type==='Polygon'?[building.footprint.coordinates]:building.footprint.coordinates;
  const base=Math.max(0,Number(building.sourceAttributes?.min_height)||0),height=building.heightM,roofRise=roof.pitched?Math.min(2.5,height*.2):0,eaves=height-roofRise;
  const floors=Math.max(1,Math.min(40,Number(building.levels)||Math.round((eaves-base)/3))),floorH=(eaves-base)/floors;
  const totalWindowSlots=polygons.reduce((sum,polygon)=>sum+polygon.reduce((n,ring)=>n+ring.slice(0,-1).reduce((count,p,i)=>{
    const a=projectLocal(p,origin),b=projectLocal(ring[i+1],origin);return count+Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/layout.bayM))*floors;
  },0),0),0);
  const totalColumns=totalWindowSlots/floors,farColumns=Math.min(totalColumns,Math.floor(512/floors));
  const deepWindowStride=Math.max(1,Math.ceil(totalWindowSlots/BUILDING_DETAIL_LIMITS.deepWindows));
  let windowsCount=0,ringCount=0,edgeCount=0,entranceCount=0,balconyCount=0,deepWindowCount=0,slotIndex=0,bandCount=0,columnIndex=0,stairwellWindowCount=0,shopfrontCount=0;const localPolygons=[],windowVariantCounts=[0,0,0],windowWidths=new Set();
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
      const bays=facadeEdgeBays(layout,length),cols=bays.length,openings=[];
      for(let col=0;col<cols;col++,columnIndex++)for(let floor=0;floor<floors;floor++){
        const bay=bays[col],bayWidth=(bay.end-bay.start)*length,p=point(bay.start),q=point(bay.end),center=(bay.start+bay.end)/2,bottom=base+floor*floorH,top=base+(floor+1)*floorH;
        const stair=bay.stair&&floors>=3&&ring===rings[0];slotIndex++;
        if(!lod&&stair&&floor===1)windowFace(plinth,p,q,base+floorH,eaves-.02,.012,.68);
        if(!lod&&ring===rings[0]&&(edge===entranceEdge&&col===Math.floor(cols/2)||shopSource&&length>12&&col%6===2)&&floor===0&&floorH>2.3&&entranceCount<(shopSource?8:4)&&bayWidth>1.8){
          const doorWidth=Math.min(family==='civic'?2:family==='industrial'?2.4:1.35,bayWidth-.35),pa=point(center-doorWidth/(2*length)),pb=point(center+doorWidth/(2*length)),topDoor=Math.min(top-.2,base+2.45);
          windowSurround(reveals,pa,pb,base+.03,topDoor,.12,{frontM:.06,backM:-.18});windowFace(entrances,pa,pb,base+.03,topDoor,-.18);
          openings.push({a:pa,b:pb,y0:base+.03,y1:topDoor});
          edgeBox(trim,point(center-(doorWidth+.5)/(2*length)),point(center+(doorWidth+.5)/(2*length)),topDoor+.08,Math.min(top-.02,topDoor+.22),.85,.025);
          edgeBox(plinth,point(center-(doorWidth+.35)/(2*length)),point(center+(doorWidth+.35)/(2*length)),base+.025,base+.13,.65);
          entranceCount++;continue;
        }
        const visibleColumn=Math.floor((columnIndex+1)*farColumns/totalColumns)>Math.floor(columnIndex*farColumns/totalColumns);
        if(bayWidth>1.35&&floorH>1.8&&windowsCount<(lod?512:2400)&&(!lod||visibleColumn)){
          const shop=shopSource&&ring===rings[0]&&floor===0&&shopfrontCount<24;
          const windowSeed=stableHash(`${building.id}:${edge}:${floor}:${col}`),width=Math.min(bayWidth-.35,shop?bayWidth-.45:bay.widthM),halfWidth=width/(2*length),wp=point(center-halfWidth),wq=point(center+halfWidth),wa=point(center-halfWidth-.075/length),wb=point(center+halfWidth+.075/length),lit=windowSeed%17===0;
          const bottomWindow=bottom+(shop?.18:stair?.42:Math.min(family==='industrial'?1.2:.9,floorH*.3)),topWindow=Math.min(top-.3,bottomWindow+(shop?2.3:stair?2.05:grammar.windowM[2]));
          const deep=!lod&&!stair&&slotIndex%deepWindowStride===0&&deepWindowCount<BUILDING_DETAIL_LIMITS.deepWindows,backM=deep?-grammar.recessM:.045,frontM=.055;
          const variant=(stableHash(`${building.id}:window-pattern`)+col+Math.floor(floor/3))%3;
          if(!lod){
            if(deep)windowSurround(reveals,wp,wq,bottomWindow,topWindow,grammar.frameM,{frontM,backM});
            else windowFace(reveals,wa,wb,bottomWindow-.065,topWindow+.065,.035,.62);
            windowVariantCounts[variant]++;
          }
          if(deep){openings.push({a:wp,b:wq,y0:bottomWindow,y1:topWindow});deepWindowCount++;}
          windowFace(lod?farWindows:lit?lightWindows:windows,wp,wq,bottomWindow,topWindow,lod?.06:backM,lit?1:[.78,.92,1][variant]);windowsCount++;
          windowWidths.add(width.toFixed(2));if(stair)stairwellWindowCount++;if(shop)shopfrontCount++;
          if(!lod){
            const split=center+(variant===1?width/6/length:0);
            windowFace(reveals,point(split-.025/length),point(split+.025/length),bottomWindow,topWindow,frontM+.006,.64);
            if((shop||family==='civic'||family==='industrial')&&variant!==0)windowFace(reveals,wp,wq,topWindow-.34,topWindow-.29,frontM+.008,.62);
          }
          if(!lod&&grammar.balconies&&!stair&&ring===rings[0]&&floor>0&&col%5===1&&bayWidth>2.2&&balconyCount<24){
            balcony(balconies,point(center-.85/length),point(center+.85/length),bottom);balconyCount++;
          }else if(!lod&&deep)edgeBox(trim,wa,wb,bottomWindow-.10,bottomWindow-.02,.22,.015);
        }
      }
      wallFace(shell,a,b,base,eaves,lod?[]:openings,.96);
      if(lod&&!roofRise)coarseParapet(roofMesh,a,b,height);
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
  return {meshes,metadata:{canonicalId:building.id,osmId:building.osmId,aliases:building.aliases??[],name:building.name??null,sourceClass:building.sourceClass,sourceHeightM:height,heightQuality:building.heightQuality,baseHeightM:base,footprint:building.footprint,family,roofStyle:roof.pitched?'pitched':'flat_parapet',roofStyleProvenance:roof.source,detailRepresentation:'visual_synthesis',appearance:{...appearance,facadeGrammar:{family,version:4,representation:'visual_synthesis',layout,entranceCount,balconyCount,deepWindowCount,bandCount,stairwellWindowCount,shopfrontCount,windowWidthKinds:windowWidths.size,windowVariantCounts,windowProfile:{widthM:[Math.min(...layout.pattern),Math.max(...layout.pattern)],heightM:grammar.windowM[2],recessM:grammar.recessM}},roofFixtures:fixtures?.placements??[],roofFixturePolicy:fixtures?.policy??null},windowCount:windowsCount,ringCount,edgeCount}};
}
