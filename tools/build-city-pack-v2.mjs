/** Municipal OSM geography compiler. Serial network, bounded responses, immutable cells.
 * node tools/build-city-pack-v2.mjs [--refresh]
 * No national downloads; no local scientific data; no runtime dependence on OSM editing API.
 */
import { createHash } from 'node:crypto';
import { readFile,writeFile,mkdir,rename } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { assembleRelation,geometryBounds,pointInGeometry,normalizeBuilding,normalizeRoad,cellsForBounds,indexBuildings } from './geo/city-geography.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=join(root,'apps/web/public/city-v2'),cache=join(root,'.cache/city-v2');
const refresh=process.argv.includes('--refresh');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const headers={'User-Agent':'OmniTwin-demo/2.0 (bounded municipal geography; https://github.com/Arseniy24RUS/OmniTwin-demo)','Accept':'application/json'};
await mkdir(cache,{recursive:true});await mkdir(out,{recursive:true});
const sourceLedger=[];
async function source(key,url,{query,maxBytes=96*1024*1024}={}) {
  const path=join(cache,`${key}.json`),metadataPath=join(cache,`${key}.metadata.json`);
  if(!refresh)try{const [data,meta]=await Promise.all([readFile(path),readFile(metadataPath,'utf8').then(JSON.parse)]);if(sha(data)!==meta.sha256)throw new Error('cache hash');sourceLedger.push(meta);return JSON.parse(data);}catch{}
  const response=await fetch(url,{headers:query?{...headers,'Content-Type':'application/x-www-form-urlencoded'}:headers,method:query?'POST':'GET',body:query?new URLSearchParams({data:query}):undefined,signal:AbortSignal.timeout(150_000)});
  if(!response.ok)throw new Error(`Source ${key}: HTTP ${response.status}`);
  const chunks=[];let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>maxBytes)throw new Error(`Source ${key} exceeds ${maxBytes} byte bound`);chunks.push(chunk);}
  const data=Buffer.concat(chunks),parsed=JSON.parse(data);
  if(parsed.remark)throw new Error(`Incomplete Overpass response: ${parsed.remark}`);
  const meta={sourceId:key,url,query:query??null,retrievedAt:new Date().toISOString(),datasetTimestamp:parsed.osm3s?.timestamp_osm_base??null,sha256:sha(data),bytes:data.length,license:'ODbL-1.0',licenseUrl:'https://opendatacommons.org/licenses/odbl/1-0/'};
  await writeFile(path,data);await writeFile(metadataPath,JSON.stringify(meta));sourceLedger.push(meta);
  console.log(`Source ${key}: ${data.length} bytes, ${parsed.elements?.length} elements`);return parsed;
}
function expandRelation(data,id) {
  const elements=new Map(data.elements.map(e=>[`${e.type}/${e.id}`,e]));
  const relation=elements.get(`relation/${id}`);assert.ok(relation,`Missing relation ${id}`);
  return {...relation,members:relation.members.map(m=>m.type==='way'?{...m,geometry:elements.get(`way/${m.ref}`)?.nodes.map(n=>elements.get(`node/${n}`))}:m)};
}
const municipalityData=await source('boundary-relation-398407','https://api.openstreetmap.org/api/0.6/relation/398407/full.json',{maxBytes:4*1024*1024});
const municipality=expandRelation(municipalityData,398407),municipalityGeometry=assembleRelation(municipality);
assert.equal(municipality.tags.name,'Челябинский городской округ');
const childIds=municipality.members.filter(m=>m.type==='relation'&&m.role==='subarea').map(m=>m.ref);assert.equal(childIds.length,7);
const districtNames=new Map([['Центральный район','CEN'],['Калининский район','KAL'],['Курчатовский район','KUR'],['Ленинский район','LEN'],['Металлургический район','MET'],['Советский район','SOV'],['Тракторозаводский район','TRA']]);
const districts=[];
for(const id of childIds.sort((a,b)=>a-b)) {
  const data=await source(`boundary-relation-${id}`,`https://api.openstreetmap.org/api/0.6/relation/${id}/full.json`,{maxBytes:4*1024*1024});
  const relation=expandRelation(data,id),suffix=districtNames.get(relation.tags.name);assert.ok(suffix,`Unaccepted district ${relation.tags.name}`);
  const geometry=assembleRelation(relation);districts.push({type:'Feature',id:`RU-CHE-SET-${suffix}`,properties:{id:`RU-CHE-SET-${suffix}`,name:relation.tags.name,osmRelationId:id,sourceVersion:relation.version,sourceTimestamp:relation.timestamp,representation:'source_attribute'},geometry,bbox:geometryBounds(geometry)});
}
assert.equal(new Set(districts.map(d=>d.id)).size,7);
const bounds=geometryBounds(municipalityGeometry);
assert.ok(bounds[2]-bounds[0]<.7&&bounds[3]-bounds[1]<.6,'Unexpected boundary extent: inspect instead of national query');
const bbox=[bounds[1],bounds[0],bounds[3],bounds[2]].join(',');
const endpoint='https://overpass-api.de/api/interpreter';
const buildingData=await source('city-buildings',endpoint,{query:`[out:json][timeout:120][maxsize:200000000];(way["building"](${bbox});relation["building"]["type"="multipolygon"](${bbox}););out body geom;`});
const roadsData=await source('city-roads',endpoint,{query:`[out:json][timeout:120][maxsize:200000000];way["highway"](${bbox});out body geom;`});
const districtFor=point=>districts.find(d=>point[0]>=d.bbox[0]&&point[0]<=d.bbox[2]&&point[1]>=d.bbox[1]&&point[1]<=d.bbox[3]&&pointInGeometry(point,d.geometry))?.id??null;
const memberWayIds=new Set(buildingData.elements.filter(e=>e.type==='relation').flatMap(e=>(e.members??[]).filter(m=>m.type==='way'&&m.role==='outer').map(m=>m.ref)));
const buildings=[];let rejected=0,outside=0,unresolvedDistrict=0;
for(const e of buildingData.elements) {
  if(e.type==='way'&&memberWayIds.has(e.id))continue; // parent multipolygon or its members, never both
  const b=normalizeBuilding(e,null);if(!b){rejected++;continue;}
  if(!pointInGeometry(b.center,municipalityGeometry)){outside++;continue;}
  b.districtId=districtFor(b.center);if(!b.districtId)unresolvedDistrict++;
  buildings.push(b);
}
const roads=[];
for(const e of roadsData.elements){const road=normalizeRoad(e);if(!road)continue;if(!road.coordinates.some(p=>pointInGeometry(p,municipalityGeometry)))continue;roads.push(road);}
assert.ok(buildings.length>10_000&&roads.length>5_000,'City source incomplete; do not publish');
assert.ok(districts.every(d=>buildings.some(b=>b.districtId===d.id&&b.use==='residential')),'Residential coverage missing a district');
buildings.sort((a,b)=>a.id.localeCompare(b.id));buildings.forEach((b,index)=>{b.index=index;});
const sourceHash=sha(sourceLedger.map(s=>s.sha256).join('|')),packId=`chelyabinsk-osm-${sourceHash.slice(0,16)}`;
const packDir=join(out,packId);await mkdir(packDir,{recursive:true});
async function asset(name,value) {
  const data=Buffer.from(JSON.stringify(value)),hash=sha(data),url=`${packId}/${name}-${hash.slice(0,16)}.json`,path=join(out,url);
  await mkdir(dirname(path),{recursive:true});await writeFile(path,data);
  const gzip=gzipSync(data,{level:6});await writeFile(`${path}.gz`,gzip);
  return {url,sha256:hash,bytes:data.length,gzip:{url:`${url}.gz`,sha256:sha(gzip),bytes:gzip.length}};
}
const boundaryAsset=await asset('boundaries',{type:'FeatureCollection',features:[{type:'Feature',id:'RU-CHE-SET',properties:{id:'RU-CHE-SET',name:municipality.tags.name,osmRelationId:398407,sourceVersion:municipality.version,sourceTimestamp:municipality.timestamp,representation:'source_attribute'},geometry:municipalityGeometry},...districts]});
const buildingIndex=await asset('building-index',indexBuildings(buildings));buildingIndex.count=buildings.length;buildingIndex.columns=indexBuildings([]).columns;
const roadIndex=await asset('road-index',{contract:'DemoRoadIndexV2',roads:roads.sort((a,b)=>a.id.localeCompare(b.id))});roadIndex.count=roads.length;roadIndex.compilerOnly=true;
const buildingPages=[];
for(let firstIndex=0;firstIndex<buildings.length;firstIndex+=512){
  const entries=buildings.slice(firstIndex,firstIndex+512).map(({footprint,...metadata})=>metadata);
  const a=await asset(`buildings/${firstIndex/512}`,{contract:'DemoBuildingPageV2',firstIndex,buildings:entries});
  buildingPages.push({...a,firstIndex,count:entries.length,firstId:entries[0].id,lastId:entries.at(-1).id});
}
const cells=new Map();
function addToCells(record,kind,bbox){for(const cell of cellsForBounds(bbox)){let data=cells.get(cell.key);if(!data){data={contract:'DemoCityCellV2',key:cell.key,bbox:cell.bbox,buildings:[],roads:[]};cells.set(cell.key,data);}data[kind].push(record);}}
for(const b of buildings)addToCells(b,'buildings',geometryBounds(b.footprint));
for(const r of roads)addToCells(r,'roads',geometryBounds({coordinates:r.coordinates}));
assert.ok(cells.size<10_000,'Unexpected city cell expansion');
const cellAssets=[];let totalCellBytes=0;
for(const [key,cell] of [...cells].sort(([a],[b])=>a.localeCompare(b))) {
  cell.buildings.sort((a,b)=>a.id.localeCompare(b.id));cell.roads.sort((a,b)=>a.id.localeCompare(b.id));
  const a=await asset(`cells/${key}`,cell);assert.ok(a.bytes<=4*1024*1024,`Cell ${key} exceeds4MiB`);totalCellBytes+=a.bytes;
  cellAssets.push({...a,key,bbox:cell.bbox,buildingCount:cell.buildings.length,roadCount:cell.roads.length});
}
const districtCoverage=districts.map(d=>({id:d.id,name:d.properties.name,buildingCount:buildings.filter(b=>b.districtId===d.id).length,residentialBuildingCount:buildings.filter(b=>b.districtId===d.id&&b.use==='residential').length}));
const manifest={contract:'DemoCityPackManifestV2',packId,datasetVersion:sourceHash,bounds,center:[61.4026,55.1644],coverage:{status:'municipality_boundary',municipalityId:'RU-CHE-SET',districtIds:districts.map(d=>d.id),districts:districtCoverage,buildings:buildings.length,roads:roads.length,rejectedBuildingCount:rejected,outsideMunicipalityBuildingCount:outside,unresolvedDistrictBuildingCount:unresolvedDistrict,unknownUseBuildingCount:buildings.filter(b=>b.use==='unknown').length},boundaries:boundaryAsset,buildingIndex,roadIndex,buildingPages,buildingPageSize:512,cells:cellAssets,cellZoom:16,totalCellBytes,sourceLedger,
  licenses:[{name:'OpenStreetMap ODbL 1.0',url:'https://opendatacommons.org/licenses/odbl/1-0/'},{name:'OpenMapTiles schema / OpenFreeMap streamed basemap',url:'https://openfreemap.org/'}],
  attribution:'© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap',
  semantics:{populationTagsImported:false,assignments:'visual_synthesis',unknownBuildingUse:'unplaced unless explicitly resolved in later version',canonicalIds:'Planetiler OSM way*10 (OTHER) alias way*10+2 (WAY); relation*10+3',snapshotPolicy:'OSM geometry snapshot independent from pinned 20260830_080001_pt basemap; missing/new source features may not match rendered buildings',geometryAccuracy:'OSM community boundary/footprints, not official cadastral survey',runtime:'visible z16 JSON cells only; global building index is compiler/server input'},
  compilerSourceHashes:Object.fromEntries(await Promise.all(['tools/build-city-pack-v2.mjs','tools/geo/city-geography.mjs'].map(async p=>[p,sha(await readFile(join(root,p)))])))};
await writeFile(join(out,'manifest.json.tmp'),JSON.stringify(manifest,null,2)+'\n');await rename(join(out,'manifest.json.tmp'),join(out,'manifest.json'));
console.log(JSON.stringify({packId,bounds,coverage:manifest.coverage,cells:cells.size,totalCellBytes,buildingIndex},null,2));
