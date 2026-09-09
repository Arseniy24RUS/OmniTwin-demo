import { readFile, writeFile, mkdir, readdir, link, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { buildBuilding } from './buildings.mjs';
import { batchMeshes } from './batching.mjs';
import { encodeGlb, parseGlb } from './glb.mjs';
import { compressGlb } from './compression.mjs';
import { makeTileset, meshBox } from './pack.mjs';
import { canonicalBuildingIds, materialLibraryFromKit } from './compiler-materials.mjs';
import { prepareMaterialKit } from './material-kit.mjs';
import { geometryBounds } from '../geo/city-geography.mjs';
import { planCatalogJobs, ownedBuildings, sha256, unionBounds, catalogRootBoundingVolume } from './catalog-planner.mjs';
import { readCatalogOwnershipIndex, assertCatalogOwnership } from './catalog-source-index.mjs';
import { buildGreenSpace } from './green-space.mjs';
import { projectLocal } from './geometry.mjs';
import { CITY_CATALOG_OUTPUT_BUDGET_BYTES } from './catalog-run-budget.mjs';

const jsonBytes = value => Buffer.from(JSON.stringify(value,null,2)+'\n');
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
// A z15 source job spans roughly 700m in this city. Keep close uploads around
// 120m and 11MiB typed geometry, rather than spending most of the 192MiB runtime
// budget on an off-screen 350m quadrant. Whole canonical buildings never split.
const DETAIL_DIVISIONS=6,DETAIL_VERTEX_TARGET=240_000,MAX_DETAIL_LEAVES=63;
async function compilerHashes(root) {
  const files=['tools/build-city-visual-catalog.mjs','tools/visual/assets/polyhaven-materials-v1.json'];
  // Include new compiler helpers automatically; tests and generated caches cannot affect geometry provenance.
  async function scan(directory){for(const entry of await readdir(join(root,directory),{withFileTypes:true})){
    const path=`${directory}/${entry.name}`;
    if(entry.isDirectory())await scan(path);else if(entry.name.endsWith('.mjs')&&!entry.name.endsWith('.test.mjs'))files.push(path);
  }}
  await scan('tools/visual');await scan('tools/geo');files.sort(compare);
  return Object.fromEntries(await Promise.all(files.map(async path=>[path,sha256(await readFile(join(root,path)))])));
}
function under(root,path) {
  const result=resolve(root,path),part=relative(resolve(root),result);
  if(!part||part==='..'||part.startsWith(`..${sep}`)||isAbsolute(part))throw new Error('Catalog path escaped its declared root');
  return result;
}
function assetPath(root,uri) {
  if(typeof uri!=='string'||!/^[-a-zA-Z0-9_./]+$/.test(uri)||uri.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Unsafe catalog asset path');
  return under(root,uri);
}
async function immutableWrite(path,bytes,budget) {
  await mkdir(resolve(path,'..'),{recursive:true});
  try{const existing=await readFile(path);if(!existing.equals(bytes))throw new Error('Immutable catalog output differs from existing bytes');return;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(budget&&budget.usedBytes+bytes.length>budget.limit)throw new Error('Catalog output budget exceeded before immutable publication');
  // Publishing a fully written sibling with a hard link is atomic and never replaces an immutable target.
  const temporary=`${path}.pending-${randomUUID()}`;
  try{
    await writeFile(temporary,bytes,{flag:'wx'});
    try{await link(temporary,path);if(budget)budget.usedBytes+=bytes.length;}catch(error){
      if(error.code!=='EEXIST')throw error;
      const existing=await readFile(path);if(!existing.equals(bytes))throw new Error('Immutable catalog output differs from existing bytes');
    }
  }finally{
    try{await unlink(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
async function outputBytes(directory) {
  let bytes=0;
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=join(directory,entry.name);
    if(entry.isSymbolicLink())throw new Error('Catalog output cannot contain external links');
    if(entry.isDirectory())bytes+=await outputBytes(path);else bytes+=(await stat(path)).size;
  }
  return bytes;
}
async function verifyAsset(root,descriptor) {
  if(!Number.isSafeInteger(descriptor.bytes)||descriptor.bytes<1||descriptor.bytes>96*1024*1024||!/^([a-f0-9]{64})$/.test(descriptor.sha256))throw new Error('Invalid catalog integrity descriptor');
  const bytes=await readFile(assetPath(root,descriptor.uri??descriptor.url));
  if(bytes.length!==descriptor.bytes||sha256(bytes)!==descriptor.sha256)throw new Error('Catalog asset hash/byte integrity failure');
  return bytes;
}
async function readJsonIfExists(path) {
  try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
}

async function sharedMaterials(root,buildRoot,mode) {
  if(mode==='none')return null;
  if(mode!=='polyhaven-v1')throw new Error('Unsupported catalog material kit');
  const path=join(buildRoot,'material-library.json');let library=await readJsonIfExists(path);
  const sourceCatalogSha256=sha256(await readFile(join(root,'tools/visual/assets/polyhaven-materials-v1.json')));
  if(!library){const kit=await prepareMaterialKit(buildRoot);library=materialLibraryFromKit(kit,sourceCatalogSha256);await immutableWrite(path,jsonBytes(library));}
  if(library.sourceCatalogSha256!==sourceCatalogSha256||library.contract!=='CityMaterialLibraryV2')throw new Error('Cached shared material library changed');
  for(const asset of library.assets)await verifyAsset(buildRoot,asset);
  return library;
}

async function compileOwnedPack({job,buildings,sourceCells,source,sourceHash,compilerSourceHashes,materialLibrary}) {
  const bounds=unionBounds([job.bounds,...buildings.map(b=>geometryBounds(b.footprint))]);
  const origin=[(job.bounds[0]+job.bounds[2])/2,(job.bounds[1]+job.bounds[3])/2,0];
  const expected=buildings.map(b=>b.id),files=new Map(),assets=[],semantic={},decorationOwnership={};
  const ownedIds=new Set(expected),allBuildings=new Map(),allRoads=new Map();
  for(const cell of sourceCells){cell.buildings.forEach((b,index)=>allBuildings.set(b.id??`${cell.key}:building:${index}`,b));cell.roads.forEach((road,index)=>allRoads.set(road.id??`${cell.key}:road:${index}`,road));}
  // Non-owned source footprints remain exclusion solids, but only an owned
  // building's actual courtyard hole may propose furniture in this job.
  const collisionBuildings=[...allBuildings.values()].map(b=>ownedIds.has(b.id)?b:{footprint:b.footprint});
  const westSouth=projectLocal(job.bounds.slice(0,2),origin),eastNorth=projectLocal(job.bounds.slice(2),origin);
  const courtyard=buildGreenSpace([],collisionBuildings,[...allRoads.values()],{origin,boundsMeters:[...westSouth,...eastNorth],maxTrees:0,maxDecorations:24,lod:0});
  const stats={sourceCells:job.sourceCells.length,sourceBytes:job.sourceBytes,buildings:buildings.length,roads:0,trees:0,courtyardDecorations:courtyard.decorationPlacements.length,sourceRoadsForExclusion:allRoads.size,tiles:0,vertices:0,triangles:0,drawGroups:0,windowCount:0};
  let decodedGeometryBytes=0,compressedCellBytes=0;const usedImages=new Set();
  async function tile(rows,lod,name) {
    const rowIds=new Set(rows.map(b=>b.id)),detailIds=new Set(courtyard.decorationPlacements.filter(p=>p.sourceIds.some(id=>rowIds.has(id))).map(p=>p.id));
    const pieces=courtyard.meshes.filter(m=>m.decorationId&&detailIds.has(m.decorationId));let vertices=pieces.reduce((n,m)=>n+m.positions.length/3,0);const metadata=[];
    for(const building of rows){const built=buildBuilding(building,{origin,lod});vertices+=built.meshes.reduce((n,m)=>n+m.positions.length/3,0);
      if(vertices>(lod?1_700_000:DETAIL_VERTEX_TARGET)&&rows.length>1)return null;
      if(vertices>2_000_000)throw new Error('Single building exceeds bounded GLB vertex budget');
      pieces.push(...built.meshes);metadata.push(built.metadata);
    }
    const batches=batchMeshes(pieces),ids=canonicalBuildingIds(batches),wanted=rows.map(b=>b.id).sort(compare);
    if(JSON.stringify(ids)!==JSON.stringify(wanted))throw new Error('Compiled LOD dropped or duplicated canonical ownership');
    const buffer=await compressGlb(encodeGlb(batches,{origin,lod,materialTextures:materialLibrary?.materials??null}));
    if(buffer.length>96*1024*1024)throw new Error('GLB exceeds per-cell byte admission');
    compressedCellBytes+=buffer.length;
    if(compressedCellBytes>512*1024*1024)throw new Error('Compressed cell inventory exceeds bounded compiler memory');
    const parsed=parseGlb(buffer),tileDecodedBytes=parsed.json.bufferViews.reduce((n,view)=>n+view.byteLength,0);
    decodedGeometryBytes+=tileDecodedBytes;
    for(const image of parsed.json.images??[])usedImages.add(image.uri.replace(/^\.\.\//,''));
    const hash=sha256(buffer),uri=`tiles/${name}-${hash.slice(0,16)}.glb`,asset={uri,sha256:hash,bytes:buffer.length,canonicalIds:ids};
    files.set(uri,buffer);assets.push(asset);decorationOwnership[uri]=[...detailIds].sort(compare);stats.tiles++;stats.vertices+=vertices;stats.triangles+=batches.reduce((n,m)=>n+m.indices.length/3,0);stats.drawGroups+=batches.length;
    if(lod===0)for(const item of metadata){semantic[item.canonicalId]=item;stats.windowCount+=item.windowCount;}
    return {...asset,box:meshBox(batches),buildings:rows.length,decodedGeometryBytes:tileDecodedBytes};
  }
  const coarse=await tile(buildings,1,'coarse');if(!coarse)throw new Error('Coarse cell exceeds vertex admission; use partition zoom16');
  const children=[];
  async function near(rows,name,depth=0) {
    if(!rows.length)return;
    const result=await tile(rows,0,name);if(result){children.push(result);return;}
    if(depth>=6||children.length>=MAX_DETAIL_LEAVES-1)throw new Error('Detail subdivision exceeds bounded hierarchy');
    const box=unionBounds(rows.map(b=>geometryBounds(b.footprint))),axis=box[2]-box[0]>box[3]-box[1]?0:1;
    const sorted=[...rows].sort((a,b)=>a.center[axis]-b.center[axis]||compare(a.id,b.id)),mid=Math.floor(sorted.length/2);
    await near(sorted.slice(0,mid),`${name}-a`,depth+1);await near(sorted.slice(mid),`${name}-b`,depth+1);
  }
  const grid=(center,axis)=>Math.max(0,Math.min(DETAIL_DIVISIONS-1,Math.floor((center[axis]-job.bounds[axis])/(job.bounds[axis+2]-job.bounds[axis])*DETAIL_DIVISIONS)));
  for(let y=0;y<DETAIL_DIVISIONS;y++)for(let x=0;x<DETAIL_DIVISIONS;x++)await near(buildings.filter(b=>grid(b.center,0)===x&&grid(b.center,1)===y),`near-${x}-${y}`);
  if(children.length>MAX_DETAIL_LEAVES)throw new Error('Detail inventory exceeds bounded hierarchy');
  const allChildIds=children.flatMap(c=>c.canonicalIds).sort(compare);
  if(JSON.stringify(allChildIds)!==JSON.stringify(expected)||new Set(allChildIds).size!==expected.length)throw new Error('REPLACE frontier has missing or duplicate buildings');
  const tileset=makeTileset({origin,bounds,coarse,children}),tilesetBytes=jsonBytes(tileset);
  const semanticsBytes=jsonBytes({contract:'CityVisualSemanticsV1',origin,sourceDatasetVersion:source.datasetVersion,buildings:semantic,
    courtyardDecorations:{placements:courtyard.decorationPlacements,lodOwnership:decorationOwnership,diagnostics:courtyard.diagnostics.courtyardDetails,
      representation:'visual_synthesis',areaPolicy:'owned_source_building_holes_inside_owner_job_partition',exclusionPolicy:'all_verified_source_building_footprints_and_road_corridors',maximumPerJob:24}});
  const descriptor=(uri,bytes)=>({uri,bytes:bytes.length,sha256:sha256(bytes)});
  files.set('tileset.json',tilesetBytes);files.set('semantics.json',semanticsBytes);
  stats.inventoryDecodedBytes=decodedGeometryBytes;
  stats.geometryDeliveryBytes=compressedCellBytes;
  const manifest={contract:'CityVisualPackManifestV1',version:1,origin,bounds,coordinateSystem:'east-up-south',tileFrame:'east-north-up_to_ecef',coverage:'bounded_quarter',
    source:{packId:source.packId,datasetVersion:source.datasetVersion,manifestSha256:sourceHash,cells:job.sourceCells.map(c=>({key:c.key,bytes:c.bytes,sha256:c.sha256}))},
    art:{representation:'visual_synthesis',textures:{},geometry:'Whole canonical source footprints; metric material surfaces and bounded roof details'},
    populationCompatibility:{datasetId:'omnitwin-fictional-city-v2',sourceDatasetVersion:source.datasetVersion,canonicalIds:expected,reassignments:0,populationMutated:false},
    semantics:descriptor('semantics.json',semanticsBytes),tileset:descriptor('tileset.json',tilesetBytes),assets,textureAssets:[],stats,compilerSourceHashes,
    ...(materialLibrary?{materialLibrary}:{}),
    limitations:['Building and source-courtyard furniture detail; native layers retain roads, water, land and large trees.','Architectural appearance, roof fixtures and courtyard furniture are visual synthesis, not observed building attributes.','Individual cell completeness is not all-city visual acceptance.'],
    partition:{kind:'canonical_center_owner',zoom:job.partitionZoom,key:job.key,bounds:job.bounds,
      detailDivisions:DETAIL_DIVISIONS,detailVertexTarget:DETAIL_VERTEX_TARGET,maximumDetailLeaves:MAX_DETAIL_LEAVES,
      oversizedDetailPolicy:'single_whole_canonical_building_within_existing_GLB_vertex_budget'},
    acceptance:{stage:'city_catalog_increment',citywideAccepted:false,visualReview:'pending',performanceValidated:false},
    license:{sourceGeometry:'ODbL-1.0',attribution:'© OpenStreetMap contributors',sourceLedger:source.sourceLedger}};
  const manifestBytes=jsonBytes(manifest),manifestHash=sha256(manifestBytes);
  const textureMemory=(materialLibrary?.assets??[]).filter(a=>usedImages.has(a.uri)).reduce((n,a)=>n+Math.ceil(a.width*a.height*4*7/3),0);
  // Estimate a coarse/detail staging pair, with CPU and GPU geometry plus original-size texture CPU/GPU/mips.
  // The runtime admits its actual visible frontier and shares/downsamples the material library independently.
  const estimatedResidentBytes=2*(coarse.decodedGeometryBytes+Math.max(...children.map(child=>child.decodedGeometryBytes)))+textureMemory;
  if(manifestBytes.length>1024*1024||estimatedResidentBytes>576*1024*1024)throw new Error('Cell metadata/resident admission budget exceeded');
  return {files,manifestBytes,manifest,descriptor:{key:job.key,bounds,manifest:{uri:`cells/${job.key}/${manifestHash}/manifest.json`,sha256:manifestHash,bytes:manifestBytes.length},
    boundingVolume:catalogRootBoundingVolume(tileset.root),estimatedResidentBytes,inventoryDecodedBytes:decodedGeometryBytes,
    canonicalIds:expected,lodLevels:2},districtCounts:buildings.reduce((result,b)=>{const id=b.districtId??'unresolved';result[id]=(result[id]??0)+1;return result;},{})};
}

/** Small sequential jobs, immutable outputs, full hash verification when resuming receipts. */
export async function buildCityVisualCatalog(options) {
  const root=resolve(options.root),sourceRoot=resolve(options.sourceRoot??join(root,'apps/web/public/city-v2'));
  const outputRoot=under(join(root,'.cache'),relative(join(root,'.cache'),resolve(options.outputRoot??join(root,'.cache/city-visual-catalog-v1'))));
  const compileAll=options.compileAll===true;
  let maxJobs=options.maxJobs??1;
  if(compileAll&&(options.maxJobs!==undefined||options.cellKey))throw new Error('Complete catalog mode cannot restrict individual jobs');
  if(!Number.isSafeInteger(maxJobs)||maxJobs<0||maxJobs>8)throw new Error('Use zero to eight bounded jobs per invocation');
  const outputBudgetBytes=options.outputBudgetBytes??CITY_CATALOG_OUTPUT_BUDGET_BYTES;
  if(!Number.isSafeInteger(outputBudgetBytes)||outputBudgetBytes<1||outputBudgetBytes>CITY_CATALOG_OUTPUT_BUDGET_BYTES)throw new Error('Invalid catalog output budget');
  const sourceBytes=await readFile(join(sourceRoot,'manifest.json'));if(sourceBytes.length>8*1024*1024)throw new Error('City source manifest exceeds budget');
  const source=JSON.parse(sourceBytes),sourceHash=sha256(sourceBytes),jobs=planCatalogJobs(source,{partitionZoom:options.partitionZoom??15});
  if(jobs.length>4096)throw new Error('Planned catalog exceeds 4096-cell runtime budget; use partition zoom15');
  if(compileAll)maxJobs=jobs.length;
  const ownershipIndex=await readCatalogOwnershipIndex(sourceRoot,source,jobs);
  const compilerSourceHashes=await compilerHashes(root);
  const materialKit=options.materialKit??'polyhaven-v1';
  const buildId=sha256(jsonBytes({sourceHash,compilerSourceHashes,partitionZoom:options.partitionZoom??15,materialKit}));
  const buildRoot=under(outputRoot,`build-${buildId.slice(0,16)}`);await mkdir(buildRoot,{recursive:true});
  const materialLibrary=await sharedMaterials(root,buildRoot,materialKit);
  const budget={limit:outputBudgetBytes,usedBytes:await outputBytes(buildRoot)};
  if(budget.usedBytes>budget.limit)throw new Error('Existing catalog output budget exceeded');
  const receipts=new Map();let resumed=0,compiled=0,verifiedSourceBytes=0;
  const ordered=[...jobs],focus=options.focus??source.center??[61.4026,55.1644];
  ordered.sort((a,b)=>distance(a.bounds,focus)-distance(b.bounds,focus)||compare(a.key,b.key));
  if(options.cellKey&&!jobs.some(j=>j.key===options.cellKey))throw new Error('Requested visual cell is absent from source inventory');
  for(const job of jobs){
    const receipt=await readJsonIfExists(join(buildRoot,'receipts',`${job.key}.json`));if(!receipt)continue;
    if(receipt.buildId!==buildId||receipt.key!==job.key||JSON.stringify(receipt.sourceCells)!==JSON.stringify(job.sourceCells.map(c=>({key:c.key,sha256:c.sha256,bytes:c.bytes}))))throw new Error('Stale catalog resume receipt');
    // Hash source inputs again: filenames alone never establish resumed provenance.
    const sourceCells=[];
    for(const descriptor of job.sourceCells){sourceCells.push(JSON.parse(await verifyAsset(sourceRoot,descriptor)));verifiedSourceBytes+=descriptor.bytes;}
    const expectedBuildings=ownedBuildings(job,sourceCells);assertCatalogOwnership(ownershipIndex,job,expectedBuildings);
    const expectedIds=expectedBuildings.map(building=>building.id);
    if(receipt.cell){
      const manifestBytes=await verifyAsset(buildRoot,receipt.cell.manifest),manifest=JSON.parse(manifestBytes);
      const cellRoot=resolve(assetPath(buildRoot,receipt.cell.manifest.uri),'..');
      if(receipt.cell.manifest.uri!==`cells/${job.key}/${receipt.cell.manifest.sha256}/manifest.json`
        ||JSON.stringify(manifest.populationCompatibility.canonicalIds)!==JSON.stringify(receipt.cell.canonicalIds)
        ||JSON.stringify(expectedIds)!==JSON.stringify(receipt.cell.canonicalIds)
        ||JSON.stringify(manifest.bounds)!==JSON.stringify(receipt.cell.bounds)
        ||manifest.source.datasetVersion!==source.datasetVersion||manifest.source.manifestSha256!==sourceHash)throw new Error('Resumed ownership metadata mismatch');
      for(const asset of [...manifest.assets,manifest.tileset,manifest.semantics])await verifyAsset(cellRoot,asset);
    }else if(receipt.empty!==true||expectedIds.length!==0)throw new Error('Missing empty-cell proof');
    receipts.set(job.key,receipt);resumed++;
  }
  for(const job of ordered){
    if(compiled>=maxJobs)break;if(receipts.has(job.key)||options.cellKey&&job.key!==options.cellKey)continue;
    const cells=[];
    for(const descriptor of job.sourceCells){const bytes=await verifyAsset(sourceRoot,descriptor);verifiedSourceBytes+=bytes.length;const cell=JSON.parse(bytes);
      if(cell.contract!=='DemoCityCellV2'||cell.key!==descriptor.key||cell.buildings?.length!==descriptor.buildingCount||cell.roads?.length!==descriptor.roadCount||JSON.stringify(cell.bbox)!==JSON.stringify(descriptor.bbox))throw new Error('Source cell completeness/identity admission failed');cells.push(cell);}
    const buildings=ownedBuildings(job,cells);assertCatalogOwnership(ownershipIndex,job,buildings);
    const receipt={contract:'CityVisualJobReceiptV1',buildId,key:job.key,
      sourceCells:job.sourceCells.map(c=>({key:c.key,sha256:c.sha256,bytes:c.bytes})),empty:buildings.length===0,cell:null,districtCounts:{}};
    if(buildings.length){
      const pack=await compileOwnedPack({job,buildings,sourceCells:cells,source,sourceHash,compilerSourceHashes,materialLibrary});
      const target=resolve(assetPath(buildRoot,pack.descriptor.manifest.uri),'..');
      for(const [uri,bytes] of pack.files)await immutableWrite(assetPath(target,uri),bytes,budget);
      await immutableWrite(join(target,'manifest.json'),pack.manifestBytes,budget);receipt.cell=pack.descriptor;receipt.districtCounts=pack.districtCounts;
    }
    await immutableWrite(join(buildRoot,'receipts',`${job.key}.json`),jsonBytes(receipt),budget);receipts.set(job.key,receipt);compiled++;
    options.onProgress?.({key:job.key,buildings:buildings.length,empty:receipt.empty,compiled,
      finishedJobs:receipts.size,plannedJobs:jobs.length,ownedBuildings:[...receipts.values()].reduce((n,r)=>n+(r.cell?.canonicalIds.length??0),0),
      outputBytes:budget.usedBytes,outputBudgetBytes:budget.limit});
  }
  const sorted=[...receipts.values()].sort((a,b)=>compare(a.key,b.key)),cells=sorted.flatMap(r=>r.cell?[r.cell]:[]),emptyCells=sorted.filter(r=>r.empty).length;
  const ids=cells.flatMap(c=>c.canonicalIds);if(new Set(ids).size!==ids.length)throw new Error('Catalog contains duplicate canonical building owners');
  const complete=receipts.size===jobs.length;
  if(complete&&Number.isSafeInteger(source.coverage?.buildings)&&ids.length!==source.coverage.buildings)throw new Error('Complete catalog failed source building conservation');
  const catalog={contract:'CityVisualCatalogV1',version:1,catalogId:'chelyabinsk-visual-v1',coordinateSystem:'east-up-south',
    bounds:unionBounds([source.bounds,...jobs.map(j=>j.bounds),...cells.map(c=>c.bounds)]),source:{packId:source.packId,datasetVersion:source.datasetVersion,manifestSha256:sourceHash},
    populationDatasetId:'omnitwin-fictional-city-v2',coverage:{status:complete?'complete':'partial',plannedCells:jobs.length,compiledCells:cells.length,emptyCells},cells,
    ...(materialLibrary?{materialLibrary}:{})};
  const catalogBytes=jsonBytes(catalog);if(catalogBytes.length>8*1024*1024||cells.length>4096||ids.length>200_000)throw new Error('Catalog metadata budget exceeded');
  const hash=sha256(catalogBytes),catalogFile=join(buildRoot,`catalog-${hash.slice(0,16)}.json`);await immutableWrite(catalogFile,catalogBytes,budget);
  const report={catalogFile:relative(root,catalogFile).split(sep).join('/'),catalogSha256:hash,buildId,compiledJobs:compiled,resumedJobs:resumed,
    sourceIndexSha256:ownershipIndex.sourceIndexSha256,sourceUniqueBuildings:ownershipIndex.uniqueBuildings,
    pendingJobs:jobs.length-receipts.size,ownedBuildings:ids.length,verifiedSourceBytes,sourceCells:source.cells.length,sourceDistrictIds:source.coverage?.districtIds??[],
    citywideCompiled:complete,citywideVisualAccepted:false,materialDelivery:materialLibrary?'one_shared_catalog_material_library':'untextured_test_or_diagnostic',
    buildingOnly:false,courtyardPolicy:'owned_source_holes_only_max24_furniture_items_per_job_with_verified_road_exclusions',
    compileMode:compileAll?'all_planned_jobs_sequentially':'bounded',maximumJobsPerInvocation:compileAll?jobs.length:8,
    outputBytes:budget.usedBytes,outputBudgetBytes:budget.limit,memoryPolicy:'one_source_job_one_uncompressed_GLB_plus_cell_compressed_inventory',
    residentEstimate:'coarse_plus_largest_detail_staging_pair_cpu_gpu_and_original_size_shared_textures',
    inventoryDecodedBytes:cells.reduce((n,cell)=>n+cell.inventoryDecodedBytes,0)};
  const reportBytes=jsonBytes(report);await immutableWrite(join(buildRoot,`report-${sha256(reportBytes).slice(0,16)}.json`),reportBytes,budget);
  return {catalog,report,buildRoot,catalogFile};
}
function distance(bounds,focus){return (((bounds[0]+bounds[2])/2-focus[0])*Math.cos(focus[1]*Math.PI/180))**2+((bounds[1]+bounds[3])/2-focus[1])**2;}
