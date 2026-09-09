import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {decodeMovementCellContext,decodeMovementPage,movementContextAt} from '../../shared/demo-population/movement-index.mjs';
import {spatialCellKey} from '../../shared/demo-population/spatial.mjs';
export const MOVEMENT_PUBLICATION_LIMITS=Object.freeze({manifestBytes:2*1024*1024,assetBytes:8*1024*1024,totalBytes:512*1024*1024,objects:32768,cells:256,pages:8192});
const SHA=/^[a-f0-9]{64}$/,DATASET='omnitwin-fictional-city-v2';
const hash=b=>createHash('sha256').update(b).digest('hex'),object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=message=>{throw Error(`Movement publication ${message}`);};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const cellKey=v=>typeof v==='string'&&/^16\/(0|[1-9]\d{0,4})\/(0|[1-9]\d{0,4})$/.test(v)&&v.split('/').slice(1).every(n=>Number(n)<65536);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function movementPath(path){if(typeof path!=='string'||path.length>250||!/^[-A-Za-z0-9_./]+\.json(?:\.gz)?$/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..'))fail('asset path outside scope');return path;}
const bounds=v=>Array.isArray(v)&&v.length===4&&v.every(Number.isFinite)&&v[0]>=-180&&v[2]<=180&&v[1]>-85.051129&&v[3]<85.051129&&v[0]<v[2]&&v[1]<v[3];
function noUnknown(value,known){if(Array.isArray(value)){for(const v of value)noUnknown(v,known);return;}if(!object(value))return;
  if(('url'in value||'uri'in value)&&('bytes'in value||'sha256'in value)&&!known.has(value))fail('unrecognized asset family');for(const v of Object.values(value))noUnknown(v,known);}

/** Exact root→bindings/context/pages closure. All source metadata is injected
 * from separately verified known manifests; it is never an upload inventory. */
export async function collectMovementClosure({manifestName,manifestSha256,read,bases,codeHashes}){
  const L=MOVEMENT_PUBLICATION_LIMITS,known=new WeakSet(),files=new Map(),deliveries=new Map();let totalBytes=0;
  function descriptor(d){if(!object(d)||!integer(d.bytes,1,L.assetBytes)||typeof d.sha256!=='string'||!SHA.test(d.sha256))fail('invalid bounded asset descriptor');movementPath(d.url);known.add(d);}
  async function take(path,expected,max=L.assetBytes){
    movementPath(path);const bytes=await read(path,expected,max);if(!Buffer.isBuffer(bytes)||!integer(bytes.length,1,max))fail('file size exceeds bound');const sha256=hash(bytes);
    if(expected&&(bytes.length!==expected.bytes||sha256!==expected.sha256))fail(`asset integrity mismatch: ${path}`);
    const prior=files.get(path);if(prior&&(prior.bytes!==bytes.length||prior.sha256!==sha256))fail('conflicting duplicate asset');
    if(!prior){totalBytes+=bytes.length;if(files.size>=L.objects||totalBytes>L.totalBytes)fail('closure byte/object budget exceeded');files.set(path,{path,bytes:bytes.length,sha256,md5Hash:createHash('md5').update(bytes).digest('base64')});}return bytes;
  }
  if(typeof manifestSha256!=='string'||!SHA.test(manifestSha256)||manifestName!==`manifest-${manifestSha256.slice(0,16)}.json`)fail('exact root pin required');
  const rootBytes=await take(manifestName,null,L.manifestBytes);if(hash(rootBytes)!==manifestSha256)fail('manifest integrity mismatch');
  const m=JSON.parse(rootBytes);
  if(m.contract!=='DemoMovementOverlayV2'||m.version!=='source-mode-v2'||m.datasetId!==DATASET||m.representation!=='visual_synthesis'||m.scientificClaim!==false||m.scope!=='local_preview'||m.chatCompatibility!=='pending')fail('source overlay contract invalid');
  if(!object(m.baseHashes)||!object(m.sourceHashes))fail('source lineage missing');
  for(const key of ['population','spatial','geography'])if(m.baseHashes[key]!==bases[key].sha256)fail('base source pin mismatch');
  const p=bases.population.manifest,s=bases.spatial.manifest,g=bases.geography.manifest;
  if(p.contract!=='DemoPopulationManifestV2'||p.datasetId!==DATASET||p.scientificClaim!==false||p.predictiveValidation!==false||s.contract!=='DemoSpatialManifestV2'||s.datasetId!==DATASET||g.contract!=='DemoCityPackManifestV2'
    ||s.sourceHashes?.populationManifest!==bases.population.sha256||s.sourceHashes?.geographyManifest!==bases.geography.sha256||p.spatial?.geographyManifestSha256!==bases.geography.sha256
    ||m.sourceHashes.populationManifest!==bases.population.sha256||m.sourceHashes.baseSpatialManifest!==bases.spatial.sha256||m.sourceHashes.geographyManifest!==bases.geography.sha256
    ||m.sourceHashes.buildingIndex!==g.buildingIndex?.sha256||s.sourceHashes.buildingIndex!==g.buildingIndex?.sha256)fail('canonical source lineage mismatch');
  for(const [key,expected]of Object.entries(codeHashes))if(m.sourceHashes[key]!==expected)fail('runtime codec/source hash mismatch');
  if(m.overlayCodecSha256!==codeHashes.movementRoadPolicy||s.sourceHashes.populationCodec!==codeHashes.populationCodec||s.sourceHashes.spatialCodec!==codeHashes.spatialCodec)fail('source codec mismatch');
  if(!integer(m.recordCount,1,10000000)||m.recordCount!==p.recordCount||m.recordCount!==s.recordCount||!integer(m.householdCount,1,10000000)||m.householdCount!==p.householdCount||m.householdCount!==s.householdCount
    ||!integer(m.buildingCount,1,10000000)||m.buildingCount!==s.buildingCount||m.cellZoom!==16||m.pageSize!==2048||m.maxPageSize!==8192||m.maxPageBytes!==L.assetBytes)fail('canonical counts or page limits invalid');
  if(!bounds(m.bounds)||!bounds(m.sourceBounds)||m.sourceBounds[0]>m.bounds[0]||m.sourceBounds[1]>m.bounds[1]||m.sourceBounds[2]<m.bounds[2]||m.sourceBounds[3]<m.bounds[3]
    ||!Array.isArray(m.origin)||![2,3].includes(m.origin.length)||!m.origin.every(Number.isFinite)||m.origin.length===3&&m.origin[2]!==0)fail('overlay source bounds invalid');
  if(m.indexNamespace?.kind!=='local_overlay'||m.indexNamespace.sourceRoadIndexBase!==1000000||m.indexNamespace.ordering!=='lexicographic_verified_source_road_id'||m.indexNamespace.notGlobalGeographyOrdinals!==true)fail('source corridor namespace invalid');
  const covered=m.coveredBuildingIndices;if(!Array.isArray(covered)||covered.length>16384||covered.some((n,i)=>!integer(n,0,m.buildingCount-1)||i&&n<=covered[i-1]))fail('canonical covered building IDs invalid');
  async function asset(d,stem){
    descriptor(d);if(d.url!==`${stem}-${d.sha256.slice(0,16)}.json`)fail('asset path/name mismatch');const raw=await take(d.url,d),rawFile=files.get(d.url);
    if(d.gzip){descriptor(d.gzip);if(d.gzip.url!==d.url+'.gz')fail('gzip path mismatch');const compressed=await take(d.gzip.url,d.gzip);let inflated;
      try{inflated=gunzipSync(compressed,{maxOutputLength:d.bytes});}catch{fail('gzip exceeds or mismatches raw bytes');}if(!inflated.equals(raw))fail('gzip raw equivalent mismatch');
      const stored=files.get(d.gzip.url);deliveries.set(d.url,{path:d.url,raw:rawFile,stored,contentEncoding:'gzip'});deliveries.set(d.gzip.url,{path:d.gzip.url,raw:stored,stored});
    }else deliveries.set(d.url,{path:d.url,raw:rawFile,stored:rawFile});return raw;
  }
  const bindings=decodeMovementCellContext(await asset(m.bindings,'bindings'));
  if(bindings.key!==spatialCellKey(...m.origin)||!same(bindings.bindings.map(row=>row[0]).sort((a,b)=>a-b),covered)||bindings.roads.length>8192)fail('canonical bindings closure incomplete');
  const globalBindings=new Map(bindings.bindings.map(row=>[row[0],row])),globalRoads=new Map(bindings.roads.map(row=>[row.index,row]));
  for(const road of bindings.roads)if(road.sourceRoadIndex<1000000||road.sourceRoadIndex>4999999)fail('source corridor namespace mismatch');
  if(!Array.isArray(m.cells)||!integer(m.cells.length,1,L.cells))fail('cell closure invalid');const keys=new Set();let pages=0,associations=0;
  for(const cell of m.cells){
    if(!cellKey(cell.key)||keys.has(cell.key)||!bounds(cell.bbox)||!integer(cell.count,0,m.recordCount)||!Array.isArray(cell.pages))fail('duplicate or invalid cell closure');keys.add(cell.key);
    const context=decodeMovementCellContext(await asset(cell.context,`cells/${cell.key}/context`));
    if(context.key!==cell.key||context.bindings.some(row=>!same(globalBindings.get(row[0]),row))||context.roads.some(row=>!same(globalRoads.get(row.index),row)))fail('cell bindings differ from source overlay');
    let count=0,prior=-1,sequence=0;
    for(const d of cell.pages){
      if(++pages>L.pages||!integer(d.count,1,8192)||!integer(d.firstPersonIndex,prior+1,m.recordCount-1)||!integer(d.lastPersonIndex,d.firstPersonIndex,m.recordCount-1))fail('page ranges invalid');
      const page=decodeMovementPage(await asset(d,`cells/${cell.key}/pages/${String(sequence++).padStart(4,'0')}`));
      if(page.key!==cell.key||page.count!==d.count||movementContextAt(page,0).record.personIndex!==d.firstPersonIndex||movementContextAt(page,page.count-1).record.personIndex!==d.lastPersonIndex
        ||page.buildings.some(row=>row.index>=m.buildingCount))fail('page canonical membership mismatch');
      for(let i=0;i<page.count;i++){const row=movementContextAt(page,i);if(row.record.personIndex>=m.recordCount||row.householdRecords.some(person=>person.personIndex>=m.recordCount||person.householdIndex>=m.householdCount))fail('person/household ordinal outside source');}
      prior=d.lastPersonIndex;count+=page.count;
    }
    if(count!==cell.count)fail('cell/page count closure incomplete');associations+=count;
  }
  if(m.stats?.cells!==m.cells.length||m.stats?.pages!==pages||m.stats?.coveredBuildings!==covered.length)fail('manifest closure statistics mismatch');
  noUnknown(m,known);const root=files.get(manifestName);deliveries.set(manifestName,{path:manifestName,raw:root,stored:root});
  return {manifest:m,root,files:[...files.values()],deliveries:[...deliveries.values()].sort((a,b)=>a.path.localeCompare(b.path)),totalBytes,stats:{cells:m.cells.length,pages,coveredBuildings:covered.length,associations}};
}
