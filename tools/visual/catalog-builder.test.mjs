import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises';
import { resolve,join,dirname,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCityVisualCatalog } from './catalog-builder.mjs';
import { tileBounds,sha256 } from './catalog-planner.mjs';
import { projectLocal } from './geometry.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
async function fixture(t,{emptySecond=false,courtyard=false,distributed=false}={}) {
  await mkdir(join(root,'.cache'),{recursive:true});
  const directory=await mkdtemp(join(root,'.cache/catalog-compiler-test-'));
  t.after(async()=>{if(!directory.startsWith(join(root,'.cache/catalog-compiler-test-')))throw new Error('Unsafe test cleanup');await rm(directory,{recursive:true,force:true});});
  const sourceRoot=join(directory,'source');await mkdir(join(sourceRoot,'cells'),{recursive:true});
  const descriptors=[],indexRows=[];
  for(const [index,x] of [43944,43946].entries()){
    const y=20672,bbox=tileBounds(16,x,y),center=[(bbox[0]+bbox[2])/2,(bbox[1]+bbox[3])/2],id=`openmaptiles_buildings:${index+1}10`;
    const building={id,center,heightM:12,levels:4,sourceClass:'apartments',heightQuality:'source',districtId:`fixture-${index}`,footprint:{type:'Polygon',coordinates:[[
      [center[0]-.0001,center[1]-.0001],[center[0]+.0001,center[1]-.0001],[center[0]+.0001,center[1]+.0001],[center[0]-.0001,center[1]+.0001],[center[0]-.0001,center[1]-.0001]] ]}};
    if(courtyard){const r=(x,y)=>[[center[0]-x,center[1]-y],[center[0]+x,center[1]-y],[center[0]+x,center[1]+y],[center[0]-x,center[1]+y],[center[0]-x,center[1]-y]];building.footprint.coordinates=[r(.0007,.0004),r(.00055,.0003).reverse()];}
    const buildings=index===1&&emptySecond?[]:[building],roads=courtyard?[{id:`road-${index}`,className:'service',widthM:6,coordinates:[[center[0]-.001,center[1]],[center[0]+.001,center[1]]]}]:[];
    if(distributed){
      buildings.length=0;
      for(const dx of [-.0015,.0015])for(const dy of [-.001,.001]){
        const copy=structuredClone(building);copy.id=`openmaptiles_buildings:${index+1}${buildings.length+1}10`;copy.center=[center[0]+dx,center[1]+dy];
        copy.footprint.coordinates=copy.footprint.coordinates.map(r=>r.map(p=>[p[0]+dx,p[1]+dy]));buildings.push(copy);
      }
    }
    for(const item of buildings)indexRows.push([item.id,...item.center,item.districtId]);
    const cell={contract:'DemoCityCellV2',key:`16/${x}/${y}`,bbox,buildings,roads},bytes=Buffer.from(JSON.stringify(cell)),url=`cells/${x}.json`;
    await writeFile(join(sourceRoot,url),bytes);descriptors.push({key:cell.key,bbox,buildingCount:buildings.length,roadCount:roads.length,url,bytes:bytes.length,sha256:sha256(bytes)});
  }
  const bounds=[descriptors[0].bbox[0],descriptors[0].bbox[1],descriptors[1].bbox[2],descriptors[1].bbox[3]],focus=[(descriptors[0].bbox[0]+descriptors[0].bbox[2])/2,(bounds[1]+bounds[3])/2];
  const indexBytes=Buffer.from(JSON.stringify({contract:'DemoBuildingIndexV2',columns:['id','lon','lat','districtId'],rows:indexRows}));
  await writeFile(join(sourceRoot,'building-index.json'),indexBytes);
  const manifest={contract:'DemoCityPackManifestV2',packId:'fixture-city',datasetVersion:'1'.repeat(64),bounds,center:focus,cellZoom:16,cells:descriptors,
    buildingIndex:{url:'building-index.json',sha256:sha256(indexBytes),bytes:indexBytes.length,count:indexRows.length},
    coverage:{buildings:indexRows.length,districtIds:['fixture-0','fixture-1']}};
  await writeFile(join(sourceRoot,'manifest.json'),JSON.stringify(manifest));
  return {root,sourceRoot,outputRoot:join(directory,'output'),materialKit:'none',focus,maxJobs:1};
}

test('one job at a time resumes with identical immutable catalogs and both LOD ownership inventories',async t=>{
  const options=await fixture(t),first=await buildCityVisualCatalog(options);
  assert.equal(first.report.compiledJobs,1);assert.equal(first.catalog.coverage.status,'partial');assert.equal(first.catalog.cells.length,1);
  const cell=first.catalog.cells[0],manifest=JSON.parse(await readFile(join(first.buildRoot,cell.manifest.uri),'utf8'));
  assert.ok(manifest.assets.length>=2);assert.deepEqual(manifest.assets[0].canonicalIds,cell.canonicalIds);
  assert.deepEqual(manifest.assets.slice(1).flatMap(a=>a.canonicalIds).sort(),cell.canonicalIds);
  const second=await buildCityVisualCatalog(options);assert.equal(second.report.resumedJobs,1);assert.equal(second.report.compiledJobs,1);
  assert.equal(second.catalog.coverage.status,'complete');assert.equal(new Set(second.catalog.cells.flatMap(c=>c.canonicalIds)).size,2);
  const third=await buildCityVisualCatalog(options);assert.equal(third.report.resumedJobs,2);assert.equal(third.report.compiledJobs,0);
  assert.equal(third.report.catalogSha256,second.report.catalogSha256);assert.equal(third.catalogFile,second.catalogFile);
});
test('resume rejects altered GLB bytes instead of accepting a completed receipt',async t=>{
  const options=await fixture(t),built=await buildCityVisualCatalog(options),descriptor=built.catalog.cells[0];
  const manifestPath=join(built.buildRoot,descriptor.manifest.uri),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const glbPath=join(dirname(manifestPath),manifest.assets[0].uri),bytes=await readFile(glbPath);bytes[bytes.length-1]^=1;await writeFile(glbPath,bytes);
  await assert.rejects(buildCityVisualCatalog(options),/integrity/);
});
test('source-hash-verified empty jobs complete coverage without an empty mesh or invented building',async t=>{
  const options=await fixture(t,{emptySecond:true});await buildCityVisualCatalog(options);const result=await buildCityVisualCatalog(options);
  assert.deepEqual(result.catalog.coverage,{status:'complete',plannedCells:2,compiledCells:1,emptyCells:1});
  assert.equal(result.catalog.cells.length,1);assert.equal(result.report.ownedBuildings,1);
});
test('near leaves load the camera neighbourhood instead of an entire 350 metre source quadrant',async t=>{
  const options=await fixture(t,{distributed:true}),built=await buildCityVisualCatalog(options),cell=built.catalog.cells[0];
  const manifest=JSON.parse(await readFile(join(built.buildRoot,cell.manifest.uri)));
  const near=manifest.assets.slice(1);
  assert.equal(near.length,4,'four separated source buildings in one old quadrant need independent close leaves');
  assert.deepEqual(near.flatMap(a=>a.canonicalIds).sort(),cell.canonicalIds);
  assert.ok(near.every(a=>a.canonicalIds.length===1));
});
test('unsafe output roots and excessive jobs are rejected before a source build',async t=>{
  const options=await fixture(t);
  await assert.rejects(buildCityVisualCatalog({...options,maxJobs:999}),/bounded jobs/);
  await assert.rejects(buildCityVisualCatalog({...options,outputRoot:join(root,'apps/web/public/forbidden-catalog')}),/escaped/);
});
test('a hash-valid source cell omission cannot publish a local hole against the canonical index',async t=>{
  const options=await fixture(t),manifestPath=join(options.sourceRoot,'manifest.json');
  const source=JSON.parse(await readFile(manifestPath,'utf8')),descriptor=source.cells[0];
  const cell=JSON.parse(await readFile(join(options.sourceRoot,descriptor.url),'utf8'));cell.buildings=[];
  const bytes=Buffer.from(JSON.stringify(cell));await writeFile(join(options.sourceRoot,descriptor.url),bytes);
  Object.assign(descriptor,{buildingCount:0,bytes:bytes.length,sha256:sha256(bytes)});
  await writeFile(manifestPath,JSON.stringify(source));
  await assert.rejects(buildCityVisualCatalog(options),/canonical index ownership/);
});
test('explicit complete mode checkpoints every job in one pass and resumes without recompiling',async t=>{
  const options=await fixture(t),progress=[];
  const built=await buildCityVisualCatalog({...options,maxJobs:undefined,compileAll:true,onProgress:item=>progress.push(item)});
  assert.equal(built.catalog.coverage.status,'complete');assert.equal(built.report.compiledJobs,2);
  assert.deepEqual(progress.map(item=>item.finishedJobs),[1,2]);assert.ok(progress.every(item=>item.plannedJobs===2));
  const resumed=await buildCityVisualCatalog({...options,maxJobs:undefined,compileAll:true});
  assert.equal(resumed.report.compiledJobs,0);assert.equal(resumed.report.resumedJobs,2);
  assert.equal(resumed.report.catalogSha256,built.report.catalogSha256);
});
test('disk delivery budget rejects output before committing a completed cell receipt',async t=>{
  const options=await fixture(t);
  await assert.rejects(buildCityVisualCatalog({...options,outputBudgetBytes:1}),/output budget/);
});
test('catalog courtyard furniture uses verified holes and source road exclusion with one owner at every LOD',async t=>{
  const options=await fixture(t,{courtyard:true}),result=await buildCityVisualCatalog(options),cell=result.catalog.cells[0];
  const manifestPath=join(result.buildRoot,cell.manifest.uri),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const semantics=JSON.parse(await readFile(join(dirname(manifestPath),'semantics.json'),'utf8'));
  const details=semantics.courtyardDecorations;
  assert.ok(details.placements.length>0&&details.placements.length<=24);
  assert.equal(manifest.stats.courtyardDecorations,details.placements.length);
  assert.equal(manifest.stats.roads,0,'source roads remain native rendering; only exclusions are compiled here');
  const source=JSON.parse(await readFile(join(options.sourceRoot,'cells/43944.json'),'utf8'));
  const roadNorth=projectLocal(source.roads[0].coordinates[0],manifest.origin)[1];
  for(const p of details.placements){assert.equal(p.areaKind,'courtyard_hole');assert.equal(p.provenance,'visual_synthesis');assert.ok(p.sourceIds.every(id=>cell.canonicalIds.includes(id)));assert.ok(Math.abs(p.point[1]-roadNorth)>=5+p.radiusMeters-1e-6);}
  const all=details.placements.map(p=>p.id).sort();
  assert.deepEqual(details.lodOwnership[manifest.assets[0].uri],all);
  assert.deepEqual(manifest.assets.slice(1).flatMap(asset=>details.lodOwnership[asset.uri]).sort(),all);
  assert.equal(new Set(all).size,all.length);
  assert.equal(result.report.buildingOnly,false);
});
