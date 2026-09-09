import {readFile,writeFile,mkdir,link,unlink,realpath,stat} from 'node:fs/promises';
import {resolve,relative,dirname,join,isAbsolute,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {visualPath,VISUAL_PUBLICATION_LIMITS as L} from '../visual-release/closure.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex'),json=x=>Buffer.from(JSON.stringify(x,null,2)+'\n');
const fail=m=>{throw Error(`Catalog metadata finalization ${m}`);},same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// The measured geometry grammar is pinned independently of the metadata tool.
// New geometry requires a new omission-envelope audit, never a caller-supplied error.
const AUDITED_GEOMETRY=Object.freeze({
 'tools/visual/buildings.mjs':'1130d02c49bfa3aea7ae2f27b71b0c33712384b0b439045f9f981ad3bc20bdad',
 'tools/visual/building-details.mjs':'f9c1d48e39c5bd22ee148b249c6578ba92fa62d0481fb21be0b0b528dc1cc493',
 'tools/visual/geometry.mjs':'bc6115fa2326df80ff7ad67e515d40eac9a129f6f61e655d5d1c1ea8184b6139',
});
function under(root,value){const result=resolve(value),part=relative(root,result);if(!part||isAbsolute(part)||part==='..'||part.startsWith(`..${sep}`))fail('path escaped cache');return result;}
async function directory(root,value){
 const result=under(root,value);let ancestor=result;
 for(;;){try{if(await realpath(ancestor)!==ancestor)fail('directory symlink');break;}catch(e){if(e.code!=='ENOENT')throw e;ancestor=dirname(ancestor);}}
 await mkdir(result,{recursive:true});if(await realpath(result)!==result)fail('directory symlink');return result;
}
async function verified(root,descriptor,max=L.glbBytes){
 visualPath(descriptor?.uri);if(!Number.isSafeInteger(descriptor.bytes)||descriptor.bytes<1||descriptor.bytes>max||!/^[a-f0-9]{64}$/.test(descriptor.sha256??''))fail('invalid descriptor');
 const file=under(root,join(root,descriptor.uri));if(await realpath(file)!==file)fail('asset symlink');const info=await stat(file);if(!info.isFile()||info.size!==descriptor.bytes)fail('integrity size mismatch');
 const bytes=await readFile(file);if(bytes.length!==descriptor.bytes||hash(bytes)!==descriptor.sha256)fail('integrity digest mismatch');return {file,bytes};
}
async function immutable(file,bytes){
 await mkdir(dirname(file),{recursive:true});if(await realpath(dirname(file))!==dirname(file))fail('target directory symlink');
 try{if(await realpath(file)!==file||!(await readFile(file)).equals(bytes))fail('immutable output mismatch');return false;}catch(e){if(e.code!=='ENOENT')throw e;}
 const pending=file+'.pending-'+randomUUID();try{await writeFile(pending,bytes,{flag:'wx'});try{await link(pending,file);}catch(e){if(e.code!=='EEXIST')throw e;if(!(await readFile(file)).equals(bytes))fail('immutable output mismatch');}}finally{await unlink(pending);}return true;
}
async function reuse(sourceRoot,targetRoot,descriptor){
 const source=await verified(sourceRoot,descriptor),target=under(targetRoot,join(targetRoot,descriptor.uri));await mkdir(dirname(target),{recursive:true});
 if(await realpath(dirname(target))!==dirname(target))fail('target directory symlink');let created=true;
 try{await link(source.file,target);}catch(e){if(e.code!=='EEXIST')throw e;created=false;}
 // Includes resumed hardlinks; no file is ever overwritten or edited in place.
 await verified(targetRoot,descriptor);return created;
}
function ownerIds(ids){if(!Array.isArray(ids)||!ids.length||ids.length>1500)fail('canonical ownership invalid');let old='';for(const id of ids){if(!/^openmaptiles_buildings:[1-9]\d{0,19}$/.test(id)||id<=old)fail('canonical ownership invalid');old=id;}}
function correctTileset(tiles,manifest){
 const node=tiles?.root;
 if(tiles.asset?.version!=='1.1'||node?.geometricError!==32||node.refine!=='REPLACE'||node.extras?.units!=='metres'||node.extras.coordinateSystem!=='east-up-south'||node.extras.coverage!=='bounded_quarter'
  ||!/^tiles\/coarse-[a-f0-9]{16}\.glb$/.test(node.content?.uri??'')||!node.children?.length||!node.children.every(c=>c.geometricError===0&&c.refine==='REPLACE'&&!c.children))fail('unsupported geometric error or hierarchy');
 const inventory=new Map(manifest.assets.map(a=>[a.uri,a.canonicalIds])),all=manifest.populationCompatibility.canonicalIds;ownerIds(all);
 const childIds=node.children.flatMap(c=>inventory.get(c.content?.uri)??[]).sort();
 if(inventory.size!==node.children.length+1||!same(inventory.get(node.content.uri),all)||!same(childIds,all)||new Set(childIds).size!==all.length)fail('REPLACE ownership mismatch');
 return {...tiles,root:{...node,geometricError:2}};
}
/** Cache-only deterministic metadata pass. Hardlinks retain verified immutable
 * geometry bytes; new cell manifests retain the original geometry compiler ledger.
 * A receipt is committed after every cell, and the catalog only after all cells.
 * This does not activate a preview, publish, download, or mutate source artifacts. */
export async function refinalizeCityCatalog({root,inputCatalog,expectedCatalogSha256,outputRoot,onProgress}={}){
 const workspace=await realpath(resolve(root)),cache=await realpath(join(workspace,'.cache')),input=under(cache,resolve(inputCatalog));
 if(await realpath(input)!==input)fail('input symlink');const sourceRoot=dirname(input),output=await directory(cache,resolve(outputRoot));
 if(output===sourceRoot||relative(sourceRoot,output)===''||!relative(sourceRoot,output).startsWith('..'))fail('output must be a separate cache directory');
 const inputBytes=await readFile(input);if(inputBytes.length>L.catalogBytes||hash(inputBytes)!==expectedCatalogSha256)fail('input catalog integrity');
 const catalog=JSON.parse(inputBytes),coverage=catalog.coverage;
 if(catalog.contract!=='CityVisualCatalogV1'||coverage?.status!=='complete'||!Array.isArray(catalog.cells)||!catalog.cells.length||catalog.cells.length>L.cells
  ||coverage.compiledCells!==catalog.cells.length||coverage.compiledCells+coverage.emptyCells!==coverage.plannedCells||catalog.metadataTransformation)fail('complete original catalog required');
 const allIds=catalog.cells.flatMap(c=>c.canonicalIds);if(allIds.length>L.canonicalIds||new Set(allIds).size!==allIds.length||new Set(catalog.cells.map(c=>c.key)).size!==catalog.cells.length)fail('duplicate catalog ownership');
 for(const cell of catalog.cells)if(!/^[-a-z0-9_]{1,80}$/.test(cell.key)||cell.manifest?.uri!==`cells/${cell.key}/${cell.manifest.sha256}/manifest.json`)fail('cell path escaped build');
 const toolSha256=hash(await readFile(new URL(import.meta.url))),policy={contract:'CityVisualMetadataTransformationV1',version:1,kind:'audited_coarse_geometric_error',inputCatalogSha256:expectedCatalogSha256,inputCatalogBytes:inputBytes.length,toolSha256,
  fromMeters:32,toMeters:2,geometryUnchanged:true,omissionEnvelopeMeters:{roofFixtures:1.76,canopies:.875,balconies:.75,parapets:.39,recesses:.24},geometryCompilerHashes:AUDITED_GEOMETRY};
 const buildId=hash(json(policy)),buildRoot=await directory(cache,join(output,`build-${buildId.slice(0,16)}`));let linkedAssets=0,reusedBytes=0,resumedCells=0,metadataBytes=0;
 const shared=catalog.materialLibrary?.assets??[];if(shared.length>48)fail('material count');
 for(const asset of shared){linkedAssets+=Number(await reuse(sourceRoot,buildRoot,asset));reusedBytes+=asset.bytes;}
 const cells=[];
 for(const cell of catalog.cells){
  ownerIds(cell.canonicalIds);const raw=await verified(sourceRoot,cell.manifest,L.cellBytes),manifest=JSON.parse(raw.bytes),fromRoot=dirname(raw.file);
  if(manifest.contract!=='CityVisualPackManifestV1'||manifest.metadataTransformation||!same(manifest.populationCompatibility?.canonicalIds,cell.canonicalIds)
   ||manifest.populationCompatibility?.populationMutated!==false||manifest.populationCompatibility.reassignments!==0||!same(manifest.source.packId,catalog.source.packId)||!same(manifest.source.datasetVersion,catalog.source.datasetVersion)
   ||manifest.source.manifestSha256!==catalog.source.manifestSha256||!same(manifest.materialLibrary,catalog.materialLibrary)||!Array.isArray(manifest.assets)||manifest.assets.length>64
   ||manifest.tileset?.uri!=='tileset.json'||manifest.semantics?.uri!=='semantics.json'||!Array.isArray(manifest.textureAssets)||manifest.textureAssets.length>3
   ||manifest.assets.some(a=>!/^tiles\/[-a-zA-Z0-9_]+\.glb$/.test(a.uri)||!a.uri.endsWith(`-${a.sha256.slice(0,16)}.glb`)))fail('source metadata mismatch');
  for(const [file,sha] of Object.entries(AUDITED_GEOMETRY))if(manifest.compilerSourceHashes?.[file]!==sha)fail('unaudited geometry compiler');
  const tilesRaw=await verified(fromRoot,manifest.tileset,L.tilesetBytes),tiles=correctTileset(JSON.parse(tilesRaw.bytes),manifest),tilesBytes=json(tiles);
  const next={...manifest,tileset:{...manifest.tileset,sha256:hash(tilesBytes),bytes:tilesBytes.length},metadataTransformation:{...policy,inputManifestSha256:cell.manifest.sha256,inputTilesetSha256:manifest.tileset.sha256}},bytes=json(next),sha=hash(bytes),uri=`cells/${cell.key}/${sha}/manifest.json`,targetRoot=await directory(cache,dirname(join(buildRoot,uri)));
  if(bytes.length>L.cellBytes)fail('cell metadata size');
  const nextCell={...cell,manifest:{uri,sha256:sha,bytes:bytes.length}},receipt={contract:'CityVisualMetadataJobReceiptV1',buildId,inputManifestSha256:cell.manifest.sha256,cell:nextCell},receiptBytes=json(receipt),receiptPath=join(buildRoot,'receipts',cell.key+'.json');
  try{if(!(await readFile(receiptPath)).equals(receiptBytes))fail('resume receipt mismatch');resumedCells++;}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const asset of [...manifest.assets,manifest.semantics,...manifest.textureAssets]){if(reusedBytes+metadataBytes+asset.bytes>L.totalBytes)fail('output budget');linkedAssets+=Number(await reuse(fromRoot,targetRoot,asset));reusedBytes+=asset.bytes;}
  await immutable(join(targetRoot,manifest.tileset.uri),tilesBytes);await immutable(join(targetRoot,'manifest.json'),bytes);await immutable(receiptPath,receiptBytes);metadataBytes+=tilesBytes.length+bytes.length+receiptBytes.length;cells.push(nextCell);
  onProgress?.({completedCells:cells.length,totalCells:catalog.cells.length,resumedCells,linkedAssets,reusedBytes});
 }
 const nextCatalog={...catalog,cells,metadataTransformation:policy},bytes=json(nextCatalog);if(bytes.length>L.catalogBytes)fail('catalog metadata size');
 const catalogSha256=hash(bytes),catalogFile=join(buildRoot,`catalog-${catalogSha256.slice(0,16)}.json`);await immutable(catalogFile,bytes);metadataBytes+=bytes.length;
 return {catalog:nextCatalog,catalogFile,catalogSha256,buildRoot,buildId,completedCells:cells.length,resumedCells,linkedAssets,reusedBytes,metadataBytes,policy};
}
