import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {buildCityVisualCatalog} from './catalog-builder.mjs';
import {refinalizeCityCatalog} from './catalog-refinalize.mjs';
import {tileBounds,sha256} from './catalog-planner.mjs';
const root=resolve(import.meta.dirname,'../..');
async function fixture(t){
 const directory=await mkdtemp(join(root,'.cache/catalog-refinalize-test-'));
 t.after(async()=>{assert.ok(directory.startsWith(join(root,'.cache/catalog-refinalize-test-')));await rm(directory,{recursive:true,force:true});});
 const sourceRoot=join(directory,'source');await mkdir(join(sourceRoot,'cells'),{recursive:true});const cells=[],rows=[];
 for(const [i,x] of [43944,43946].entries()){
  const bbox=tileBounds(16,x,20672),center=[(bbox[0]+bbox[2])/2,(bbox[1]+bbox[3])/2],id=`openmaptiles_buildings:${i+1}10`;
  const building={id,center,heightM:12,levels:4,sourceClass:'apartments',heightQuality:'source',districtId:'fixture',footprint:{type:'Polygon',coordinates:[[[center[0]-.0001,center[1]-.0001],[center[0]+.0001,center[1]-.0001],[center[0]+.0001,center[1]+.0001],[center[0]-.0001,center[1]+.0001],[center[0]-.0001,center[1]-.0001]]]}};
  const cell={contract:'DemoCityCellV2',key:`16/${x}/20672`,bbox,buildings:[building],roads:[]},bytes=Buffer.from(JSON.stringify(cell)),url=`cells/${x}.json`;
  await writeFile(join(sourceRoot,url),bytes);cells.push({key:cell.key,bbox,buildingCount:1,roadCount:0,url,bytes:bytes.length,sha256:sha256(bytes)});rows.push([id,...center,'fixture']);
 }
 const index=Buffer.from(JSON.stringify({contract:'DemoBuildingIndexV2',columns:['id','lon','lat','districtId'],rows}));await writeFile(join(sourceRoot,'building-index.json'),index);
 const bounds=[cells[0].bbox[0],cells[0].bbox[1],cells[1].bbox[2],cells[1].bbox[3]],source={contract:'DemoCityPackManifestV2',packId:'fixture',datasetVersion:'1'.repeat(64),bounds,center:[61.4,55.16],cellZoom:16,cells,buildingIndex:{url:'building-index.json',sha256:sha256(index),bytes:index.length,count:2},coverage:{buildings:2,districtIds:['fixture']}};
 await writeFile(join(sourceRoot,'manifest.json'),JSON.stringify(source));
 const built=await buildCityVisualCatalog({root,sourceRoot,outputRoot:join(directory,'old'),materialKit:'none',compileAll:true});
 // Keep a historical 32m source independent of the future default policy.
 for(const cell of built.catalog.cells){const file=join(built.buildRoot,cell.manifest.uri),manifest=JSON.parse(await readFile(file)),tiles=JSON.parse(await readFile(join(dirname(file),'tileset.json')));tiles.root.geometricError=32;
  const tb=Buffer.from(JSON.stringify(tiles,null,2)+'\n');manifest.tileset={uri:'tileset.json',sha256:sha256(tb),bytes:tb.length};const mb=Buffer.from(JSON.stringify(manifest,null,2)+'\n'),uri=`cells/${cell.key}/${sha256(mb)}/manifest.json`,dest=join(built.buildRoot,dirname(uri));await mkdir(dest,{recursive:true});
  for(const a of [...manifest.assets,manifest.semantics]){await mkdir(dirname(join(dest,a.uri)),{recursive:true});await writeFile(join(dest,a.uri),await readFile(join(dirname(file),a.uri)));}await writeFile(join(dest,'tileset.json'),tb);await writeFile(join(dest,'manifest.json'),mb);cell.manifest={uri,sha256:sha256(mb),bytes:mb.length};}
 const bytes=Buffer.from(JSON.stringify(built.catalog,null,2)+'\n'),inputCatalog=join(built.buildRoot,'legacy-catalog.json');await writeFile(inputCatalog,bytes);
 return {root,inputCatalog,expectedCatalogSha256:sha256(bytes),outputRoot:join(directory,'new'),built};
}
test('metadata-only 2m finalization keeps GLBs, semantic/source bytes and compiler provenance, and is deterministic',async t=>{
 const options=await fixture(t),a=await refinalizeCityCatalog(options),b=await refinalizeCityCatalog({...options,outputRoot:options.outputRoot+'-repeat'});
 t.after(async()=>{assert.ok((options.outputRoot+'-repeat').startsWith(join(root,'.cache/')));await rm(options.outputRoot+'-repeat',{recursive:true,force:true});});
 assert.equal(a.catalogSha256,b.catalogSha256);assert.equal(a.catalog.cells.length,2);assert.equal(a.linkedAssets,6);
 for(let i=0;i<2;i++){const oldCell=options.built.catalog.cells[i],cell=a.catalog.cells[i],oldPath=join(options.built.buildRoot,oldCell.manifest.uri),newPath=join(a.buildRoot,cell.manifest.uri),old=JSON.parse(await readFile(oldPath)),next=JSON.parse(await readFile(newPath));
  assert.deepEqual(next.compilerSourceHashes,old.compilerSourceHashes);assert.deepEqual(next.source,old.source);assert.deepEqual(next.populationCompatibility,old.populationCompatibility);assert.deepEqual(next.assets,old.assets);assert.deepEqual(next.semantics,old.semantics);
  assert.equal(next.metadataTransformation.inputCatalogSha256,options.expectedCatalogSha256);assert.equal(next.metadataTransformation.inputTilesetSha256,old.tileset.sha256);
  const tiles=JSON.parse(await readFile(join(dirname(newPath),'tileset.json'))),before=JSON.parse(await readFile(join(dirname(oldPath),'tileset.json')));assert.equal(tiles.root.geometricError,2);tiles.root.geometricError=32;assert.deepEqual(tiles,before);
  for(const asset of [...old.assets,old.semantics])assert.equal((await stat(join(dirname(newPath),asset.uri))).ino,(await stat(join(dirname(oldPath),asset.uri))).ino);
 }
});
test('interrupted finalization resumes immutable receipts and preserves original catalog',async t=>{
 const options=await fixture(t),before=await readFile(options.inputCatalog);let count=0;
 await assert.rejects(refinalizeCityCatalog({...options,onProgress:()=>{if(++count===1)throw Error('test interruption');}}),/test interruption/);
 const resumed=await refinalizeCityCatalog(options);assert.equal(resumed.resumedCells,1);assert.equal(resumed.completedCells,2);assert.ok(before.equals(await readFile(options.inputCatalog)));
});
test('corrupt geometry and an escaped output fail closed',async t=>{
 const options=await fixture(t);await assert.rejects(refinalizeCityCatalog({...options,outputRoot:join(root,'apps/web/public/invalid')}),/cache|escaped/);
 const cell=options.built.catalog.cells[0],file=join(options.built.buildRoot,cell.manifest.uri),m=JSON.parse(await readFile(file)),asset=join(dirname(file),m.assets[0].uri),bytes=await readFile(asset);bytes[bytes.length-1]^=1;await writeFile(asset,bytes);
  await assert.rejects(refinalizeCityCatalog(options),/integrity/);
});
test('hash-valid unsupported geometric error and duplicate catalog ownership are rejected',async t=>{
 const options=await fixture(t),catalog=JSON.parse(await readFile(options.inputCatalog));catalog.cells.push(catalog.cells[0]);catalog.coverage.compiledCells++;catalog.coverage.plannedCells++;
 let bytes=Buffer.from(JSON.stringify(catalog));await writeFile(options.inputCatalog,bytes);
 await assert.rejects(refinalizeCityCatalog({...options,expectedCatalogSha256:sha256(bytes)}),/duplicate/);
 catalog.cells.pop();catalog.coverage.compiledCells--;catalog.coverage.plannedCells--;
 const cell=catalog.cells[0],oldFile=join(options.built.buildRoot,cell.manifest.uri),m=JSON.parse(await readFile(oldFile)),tiles=JSON.parse(await readFile(join(dirname(oldFile),'tileset.json')));tiles.root.geometricError=100;
 const tb=Buffer.from(JSON.stringify(tiles));m.tileset={uri:'tileset.json',bytes:tb.length,sha256:sha256(tb)};const mb=Buffer.from(JSON.stringify(m));cell.manifest={uri:`cells/${cell.key}/${sha256(mb)}/manifest.json`,sha256:sha256(mb),bytes:mb.length};const next=join(options.built.buildRoot,cell.manifest.uri);await mkdir(dirname(next),{recursive:true});await writeFile(next,mb);await writeFile(join(dirname(next),'tileset.json'),tb);
 bytes=Buffer.from(JSON.stringify(catalog));await writeFile(options.inputCatalog,bytes);
 await assert.rejects(refinalizeCityCatalog({...options,expectedCatalogSha256:sha256(bytes)}),/unsupported geometric error/);
});
