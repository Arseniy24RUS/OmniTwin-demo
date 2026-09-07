/** Pure, bounded build-time geographic transforms. No browser joins or invented footprints. */
export const BUILDING_COLUMNS = ['id','lon','lat','districtId','use','areaM2','levels','heightM','capacityWeight','classificationProvenance','aliases'];
const finite = p => Array.isArray(p) && p.length>=2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const xy = p => [p.lon,p.lat];
const equal = (a,b) => a[0]===b[0] && a[1]===b[1];
const positive = v => Number.isFinite(Number(v)) && Number(v)>0 ? Number(v) : null;
const rounded = n => Math.round(n*100)/100;
export function geometryBounds(geometry) {
  let west=Infinity,south=Infinity,east=-Infinity,north=-Infinity;
  const walk=v=>{if(finite(v)){west=Math.min(west,v[0]);east=Math.max(east,v[0]);south=Math.min(south,v[1]);north=Math.max(north,v[1]);}else if(Array.isArray(v))v.forEach(walk);};
  walk(geometry.coordinates); return [west,south,east,north];
}
export function pointInRing(point, ring) {
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[i],b=ring[j];
    if(((a[1]>point[1])!==(b[1]>point[1])) && point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
export function pointInGeometry(point, geometry) {
  const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
  return polygons.some(p=>pointInRing(point,p[0])&&!p.slice(1).some(h=>pointInRing(point,h)));
}
function stitch(lines) {
  const pending=lines.map(line=>line.map(p=>[...p])), rings=[];
  while(pending.length) {
    const ring=pending.shift();
    while(!equal(ring[0],ring.at(-1))) {
      let found=-1,reverse=false;
      for(let i=0;i<pending.length;i++) {
        if(equal(pending[i][0],ring.at(-1))){found=i;break;}
        if(equal(pending[i].at(-1),ring.at(-1))){found=i;reverse=true;break;}
      }
      if(found<0)throw new Error('Unclosed OSM boundary/footprint relation');
      const next=pending.splice(found,1)[0]; if(reverse)next.reverse(); ring.push(...next.slice(1));
    }
    if(ring.length<4)throw new Error('Invalid OSM polygon ring'); rings.push(ring);
  }
  return rings;
}
export function assembleRelation(relation) {
  const members=relation.members.filter(m=>m.type==='way' && ['outer','inner',''].includes(m.role));
  if(members.some(m=>!m.geometry?.length))throw new Error('Missing OSM relation geometry');
  const outer=stitch(members.filter(m=>m.role!=='inner').map(m=>m.geometry.map(xy)));
  const inner=stitch(members.filter(m=>m.role==='inner').map(m=>m.geometry.map(xy)));
  if(!outer.length)throw new Error('OSM relation has no outer ring');
  const polygons=outer.map(r=>[r]);
  for(const ring of inner){const polygon=polygons.find(p=>pointInRing(ring[0],p[0]));if(!polygon)throw new Error('Orphan OSM inner ring');polygon.push(ring);}
  return polygons.length===1?{type:'Polygon',coordinates:polygons[0]}:{type:'MultiPolygon',coordinates:polygons};
}
export function footprintAreaM2(geometry) {
  const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
  const ringArea=ring=>{const lat=ring.reduce((s,p)=>s+p[1],0)/ring.length;const sx=111320*Math.cos(lat*Math.PI/180),sy=110540;let a=0;const o=ring[0];for(let i=1;i<ring.length;i++){const p=ring[i-1],q=ring[i];a+=(p[0]-o[0])*(q[1]-o[1])-(q[0]-o[0])*(p[1]-o[1]);}return Math.abs(a*sx*sy/2);};
  return polygons.reduce((sum,p)=>sum+ringArea(p[0])-p.slice(1).reduce((s,r)=>s+ringArea(r),0),0);
}
export function classifyBuilding(tags) {
  const kind=String(tags.building??'').toLowerCase(), amenity=String(tags.amenity??'').toLowerCase();
  if(['school','university','college','kindergarten','dormitory'].includes(kind)||['school','university','college','kindergarten'].includes(amenity))return 'study';
  if(['apartments','residential','house','detached','semidetached_house','terrace','bungalow','cabin'].includes(kind))return 'residential';
  if(['retail','commercial','office','industrial','warehouse','hospital','civic','public','train_station','hotel','sports_hall','supermarket','church'].includes(kind)||tags.shop||tags.office||['hospital','clinic','townhall','marketplace','bank','restaurant','cafe'].includes(amenity))return 'work';
  return 'unknown';
}
export function normalizeBuilding(element,districtId) {
  const tags=element.tags??{};
  if(tags['building:part'] && tags['building:part']!=='no')return null;
  let footprint;
  try { footprint=element.type==='relation'?assembleRelation(element):{type:'Polygon',coordinates:[(element.geometry??[]).map(xy)]}; } catch{return null;}
  if(!footprint.coordinates.length || footprint.type==='Polygon' && (footprint.coordinates[0].length<4||!equal(footprint.coordinates[0][0],footprint.coordinates[0].at(-1))))return null;
  const areaM2=rounded(footprintAreaM2(footprint));if(!Number.isFinite(areaM2)||areaM2<=1)return null;
  const bounds=geometryBounds(footprint), center=[(bounds[0]+bounds[2])/2,(bounds[1]+bounds[3])/2];
  const sourceLevels=positive(tags['building:levels']),sourceHeight=positive(tags.height);
  const levels=sourceLevels??(sourceHeight?Math.max(1,Math.round(sourceHeight/3)):null);
  const heightM=sourceHeight??(sourceLevels?sourceLevels*3:5);
  const use=classifyBuilding(tags);
  // Display-only floor-area weights, not observed capacity or a new scientific coefficient.
  const capacityWeight=use==='unknown'?0:rounded(areaM2*(levels??1)/(use==='residential'?28:use==='study'?8:18));
  return {id:`openmaptiles_buildings:${element.id*10+(element.type==='relation'?3:0)}`,aliases:element.type==='way'?[`openmaptiles_buildings:${element.id*10+2}`]:[],osmId:`${element.type}/${element.id}`,center,districtId,use,areaM2,levels,heightM,
    heightQuality:sourceHeight?'exact':sourceLevels?'derived_floors':'approximate_fixed_5m',capacityWeight,
    capacityRepresentation:'visual_synthesis',classificationProvenance:use==='unknown'?'unknown':'source_attribute',
    sourceClass:tags.building??null,name:tags.name??null,footprint,
    sourceAttributes:Object.fromEntries(['building','building:levels','height','amenity','shop','office','roof:shape','roof:material','roof:colour','building:material','addr:street','addr:housenumber'].filter(k=>tags[k]).map(k=>[k,tags[k]]))};
}
export function normalizeRoad(element) {
  const tags=element.tags??{},kind=tags.highway;
  if(!kind||['construction','proposed','raceway'].includes(kind)||['private','no'].includes(tags.access))return null;
  const coordinates=(element.geometry??[]).map(xy);if(coordinates.length<2||coordinates.some(p=>!finite(p)))return null;
  const reverse=tags.oneway==='-1';if(reverse)coordinates.reverse();
  const drivable=!['footway','pedestrian','path','steps','cycleway','bridleway','corridor','platform'].includes(kind)&&!['no','private'].includes(tags.motor_vehicle??tags.vehicle);
  const walkable=!['motorway','motorway_link','trunk','trunk_link'].includes(kind)&&tags.foot!=='no';
  if(!walkable&&!drivable)return null;
  return {id:`osm-road:${element.id}`,coordinates,oneway:reverse||['yes','1','true'].includes(tags.oneway)||tags.junction==='roundabout',walkable,drivable,className:kind,
    startNodeId:`osm-node:${reverse?element.nodes?.at(-1):element.nodes?.[0]}`,endNodeId:`osm-node:${reverse?element.nodes?.[0]:element.nodes?.at(-1)}`,
    nodeIds:(reverse?[...(element.nodes??[])].reverse():element.nodes??[]).map(n=>`osm-node:${n}`),
    lanes:positive(tags.lanes),maxspeed:positive(tags.maxspeed),bridge:tags.bridge&&tags.bridge!=='no'||false,tunnel:tags.tunnel&&tags.tunnel!=='no'||false,
    layer:Number(tags.layer)||0,name:tags.name??null};
}
export function cellsForBounds(bounds,z=16) {
  const n=2**z,x=lon=>Math.floor((lon+180)/360*n),y=lat=>Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n);
  const lon=t=>t/n*360-180,lat=t=>Math.atan(Math.sinh(Math.PI*(1-2*t/n)))*180/Math.PI;
  const result=[];for(let ix=x(bounds[0]);ix<=x(bounds[2]);ix++)for(let iy=y(bounds[3]);iy<=y(bounds[1]);iy++)result.push({key:`${z}/${ix}/${iy}`,bbox:[lon(ix),lat(iy+1),lon(ix+1),lat(iy)]});
  return result;
}
export function indexBuildings(buildings) {
  const map=new Map();for(const b of buildings)if(!map.has(b.id)||map.get(b.id).areaM2<b.areaM2)map.set(b.id,b);
  return {contract:'DemoBuildingIndexV2',columns:BUILDING_COLUMNS,rows:[...map.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(b=>[b.id,...b.center,b.districtId,b.use,b.areaM2,b.levels,b.heightM,b.capacityWeight,b.classificationProvenance,b.aliases??[]])};
}
