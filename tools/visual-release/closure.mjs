import {createHash} from 'node:crypto';
import {posix} from 'node:path';

export const VISUAL_PUBLICATION_LIMITS=Object.freeze({rootBytes:1024*1024,catalogBytes:8*1024*1024,cellBytes:1024*1024,
  tilesetBytes:256*1024,semanticsBytes:16*1024*1024,glbBytes:96*1024*1024,textureBytes:16*1024*1024,
  kitBytes:32*1024*1024,objects:40000,totalBytes:20*1024**3,cells:4096,canonicalIds:200000,glbJsonBytes:8*1024*1024});
const SHA=/^[a-f0-9]{64}$/,ID=/^openmaptiles_buildings:[1-9]\d{0,19}$/;
const hash=b=>createHash('sha256').update(b).digest('hex');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=message=>{throw Error(`Visual publication ${message}`);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function visualPath(uri){
  if(typeof uri!=='string'||uri.length>600||!/^[-A-Za-z0-9_./]+$/.test(uri)||uri.startsWith('/')
    ||uri.split('/').some(part=>!part||part==='.'||part==='..')||! /\.(json|glb|jpg|jpeg|png)$/.test(uri))fail('asset path outside approved scope');
  return uri;
}
function ids(value,allowEmpty=false){
  if(!Array.isArray(value)||value.length>1500||!allowEmpty&&!value.length)fail('canonical ownership invalid');
  let prior='';for(const id of value){if(typeof id!=='string'||!ID.test(id)||id<=prior)fail('duplicate or unsorted canonical ownership');prior=id;}return value;
}
function descriptor(value,max,known){
  if(!object(value)||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>max||!SHA.test(value.sha256??''))fail('invalid bounded asset descriptor');
  visualPath(value.uri);known.add(value);return value;
}
function source(value){if(!object(value)||typeof value.packId!=='string'||!/^[a-z0-9][a-z0-9_-]{0,100}$/.test(value.packId)||typeof value.datasetVersion!=='string'||!SHA.test(value.datasetVersion)||typeof value.manifestSha256!=='string'||!SHA.test(value.manifestSha256))fail('source lineage invalid');return {packId:value.packId,datasetVersion:value.datasetVersion,manifestSha256:value.manifestSha256};}
function noUnknownAssets(value,known){
  if(Array.isArray(value)){for(const entry of value)noUnknownAssets(entry,known);return;}
  if(!object(value))return;
  if(('uri' in value||'url' in value)&&('bytes' in value||'sha256' in value)&&!known.has(value))fail('unrecognized asset family');
  for(const entry of Object.values(value))noUnknownAssets(entry,known);
}
function sourceAttribution(manifest,known){
  // This exact upstream ledger is attribution, never a download inventory.
  // Other URL+hash descriptors still fail closed in noUnknownAssets.
  const ledger=manifest.license?.sourceLedger;if(ledger===undefined)return;
  if(!Array.isArray(ledger)||ledger.length>256)fail('source attribution ledger invalid');
  for(const entry of ledger){
    if(!object(entry)||typeof entry.sourceId!=='string'||typeof entry.url!=='string'||!entry.url.startsWith('https://')
      ||typeof entry.sha256!=='string'||!SHA.test(entry.sha256)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||'uri' in entry)fail('source attribution invalid');
    known.add(entry);
  }
}
function materialAssets(library,known){
  if(library===undefined)return [];
  if(!object(library)||library.contract!=='CityMaterialLibraryV2'||library.version!==2||library.mode!=='metric_repeat'
    ||library.representation!=='visual_synthesis'||library.provider!=='Poly Haven'||library.license!=='CC0-1.0'
    ||library.licenseUrl!=='https://polyhaven.com/license'||!SHA.test(library.sourceCatalogSha256??'')
    ||!Array.isArray(library.assets)||!library.assets.length||library.assets.length>48||!object(library.materials)
    ||!Object.keys(library.materials).length||Object.keys(library.materials).length>16)fail('material library invalid');
  const paths=new Map();let total=0;
  for(const entry of library.assets){descriptor(entry,VISUAL_PUBLICATION_LIMITS.textureBytes,known);
    if(!['baseColor','normal','orm'].includes(entry.role)||!/^materials\/[A-Za-z0-9_-]+\.jpg$/.test(entry.uri)
      ||!entry.uri.endsWith(`-${entry.sha256.slice(0,16)}.jpg`)||paths.has(entry.uri)
      ||!Number.isInteger(entry.width)||!Number.isInteger(entry.height)||entry.width<1||entry.height<1||entry.width>2048||entry.height>2048)fail('duplicate or invalid material asset');
    paths.set(entry.uri,entry);total+=entry.bytes;
  }
  if(total>VISUAL_PUBLICATION_LIMITS.kitBytes)fail('material budget exceeded');
  for(const material of Object.values(library.materials)){
    if(!object(material)||!Array.isArray(material.repeatMeters)||material.repeatMeters.length!==2||!material.repeatMeters.every(n=>Number.isFinite(n)&&n>0))fail('material scale invalid');
    for(const [key,role] of [['baseColorUri','baseColor'],['normalUri','normal'],['ormUri','orm']]){
      const uri=material[key];if(uri===undefined&&key!=='baseColorUri')continue;
      if(typeof uri!=='string'||!uri.startsWith('../')||paths.get(uri.slice(3))?.role!==role)fail('material texture closure incomplete');
    }
  }
  return library.assets;
}
function glbJson(bytes){
  if(bytes.length<20||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length
    ||bytes.readUInt32LE(16)!==0x4e4f534a)fail('GLB header invalid');
  const length=bytes.readUInt32LE(12);if(length<2||length>VISUAL_PUBLICATION_LIMITS.glbJsonBytes||20+length>bytes.length)fail('GLB JSON budget invalid');
  try{return JSON.parse(bytes.subarray(20,20+length).toString('utf8'));}catch{fail('GLB JSON invalid');}
}

/** Descriptor-driven closure only. The injected reader owns bounded filesystem
 * reads; source/provenance URLs, unreferenced files and actor assets are not traversed. */
export async function collectCityVisualClosure({read,requireComplete=true}){
  const files=new Map(),known=new WeakSet(),manifestOrder=[],L=VISUAL_PUBLICATION_LIMITS;let totalBytes=0;
  async function take(path,expected,max,kind){
    visualPath(path);if(expected)descriptor(expected,max,known);
    const prior=files.get(path);if(prior){
      if(expected&&(prior.bytes!==expected.bytes||prior.sha256!==expected.sha256))fail('conflicting duplicate asset descriptor');
      const bytes=await read(path,prior,max);if(!Buffer.isBuffer(bytes)||bytes.length!==prior.bytes||hash(bytes)!==prior.sha256)fail('duplicate asset changed during plan');return bytes;
    }
    const bytes=await read(path,expected,max);if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>max)fail('asset size outside bound');
    const sha256=hash(bytes);if(expected&&(bytes.length!==expected.bytes||sha256!==expected.sha256))fail(`asset integrity mismatch: ${path}`);
    totalBytes+=bytes.length;if(files.size>=L.objects||totalBytes>L.totalBytes)fail('closure budget exceeded');
    files.set(path,{path,bytes:bytes.length,sha256,md5Hash:createHash('md5').update(bytes).digest('base64'),kind});return bytes;
  }
  const parsed=(bytes,label)=>{try{return JSON.parse(bytes.toString('utf8'));}catch{fail(`${label} JSON invalid`);}};
  const rootBytes=await take('manifest.json',null,L.rootBytes,'root_manifest'),root=parsed(rootBytes,'root');
  const lineage=source(root.source),populationDatasetId=root.populationCompatibility?.datasetId;
  if(populationDatasetId!=='omnitwin-fictional-city-v2')fail('population compatibility invalid');
  if(!root.visualCatalog)fail('root catalog closure missing');
  descriptor(root.visualCatalog,L.catalogBytes,known);
  if(!root.visualCatalog.uri.startsWith('catalog/'))fail('catalog path outside scope');
  const catalogPath=root.visualCatalog.uri,catalogBase=posix.dirname(catalogPath)+'/';
  const catalogBytes=await take(catalogPath,root.visualCatalog,L.catalogBytes,'catalog_manifest'),catalog=parsed(catalogBytes,'catalog');
  if(catalog.contract!=='CityVisualCatalogV1'||catalog.version!==1||catalog.coordinateSystem!=='east-up-south'
    ||catalog.populationDatasetId!==populationDatasetId||!same(source(catalog.source),lineage)||!object(catalog.coverage)
    ||!Array.isArray(catalog.cells)||catalog.cells.length>L.cells||catalog.coverage.compiledCells!==catalog.cells.length)fail('catalog contract or lineage invalid');
  const c=catalog.coverage,finished=c.compiledCells+(c.emptyCells??0);
  if(!Number.isSafeInteger(c.plannedCells)||c.plannedCells<1||c.plannedCells>L.cells||!Number.isSafeInteger(c.emptyCells??0)||(c.emptyCells??0)<0
    ||finished>c.plannedCells||!['partial','complete'].includes(c.status)||(c.status==='complete')!==(finished===c.plannedCells)
    ||requireComplete&&c.status!=='complete')fail('complete catalog required; partial or invalid coverage');
  const shared=materialAssets(catalog.materialLibrary,known),sharedPaths=new Map();
  for(const asset of shared){await take(catalogBase+asset.uri,asset,L.textureBytes,'texture');sharedPaths.set(asset.uri,catalogBase+asset.uri);}

  async function pack(path,manifest,expectedIds,isCell){
    const base=posix.dirname(path)==='.'?'':posix.dirname(path)+'/';
    if(manifest.contract!=='CityVisualPackManifestV1'||manifest.version!==1||manifest.coordinateSystem!=='east-up-south'
      ||manifest.tileFrame!=='east-north-up_to_ecef'||!same(source(manifest.source),lineage))fail('cell/root manifest source contract mismatch');
    const compatibility=manifest.populationCompatibility,owners=ids(compatibility?.canonicalIds);
    if(compatibility.datasetId!==populationDatasetId||compatibility.sourceDatasetVersion!==lineage.datasetVersion
      ||compatibility.reassignments!==0||compatibility.populationMutated!==false||expectedIds&&!same(owners,expectedIds))fail('cell canonical ownership mismatch');
    if(isCell&&manifest.visualCatalog!==undefined)fail('nested catalog is not an approved asset family');
    if(!Array.isArray(manifest.assets)||!manifest.assets.length||manifest.assets.length>64||!Array.isArray(manifest.textureAssets)||manifest.textureAssets.length>3)fail('pack inventory invalid');
    const metric=materialAssets(manifest.materialLibrary,known);
    if(isCell&&shared.length&&!same(manifest.materialLibrary,catalog.materialLibrary))fail('shared cell material mismatch');
    const texturePaths=new Map(),localSeen=new Set(['tileset.json','semantics.json']);
    for(const asset of [...manifest.textureAssets,...metric]){
      descriptor(asset,L.textureBytes,known);if(localSeen.has(asset.uri))fail('duplicate pack texture');localSeen.add(asset.uri);
      if(!/^materials\/[-A-Za-z0-9_]+\.(png|jpg)$/.test(asset.uri))fail('texture path invalid');
      const actual=isCell&&sharedPaths.has(asset.uri)?sharedPaths.get(asset.uri):base+asset.uri;
      if(!files.has(actual))await take(actual,asset,L.textureBytes,'texture');
      else if(files.get(actual).sha256!==asset.sha256||files.get(actual).bytes!==asset.bytes)fail('shared texture integrity mismatch');
      texturePaths.set(`../${asset.uri}`,actual);
    }
    const tileOwners=new Map();
    for(const asset of manifest.assets){
      descriptor(asset,L.glbBytes,known);if(!/^tiles\/[-A-Za-z0-9_]+\.glb$/.test(asset.uri)||!asset.uri.endsWith(`-${asset.sha256.slice(0,16)}.glb`)||localSeen.has(asset.uri))fail('duplicate or invalid GLB path');localSeen.add(asset.uri);
      const bytes=await take(base+asset.uri,asset,L.glbBytes,'glb'),gltf=glbJson(bytes);
      if(gltf.asset?.version!=='2.0'||!Array.isArray(gltf.meshes)||(gltf.buffers??[]).some(buffer=>buffer.uri!==undefined))fail('external or invalid GLB buffer closure');
      for(const image of gltf.images??[])if(typeof image.uri!=='string'||!texturePaths.has(image.uri))fail('GLB image closure incomplete');
      const actualIds=[...new Set(gltf.meshes.flatMap(mesh=>[...(mesh.extras?.featureRanges??[]).map(range=>range.canonicalId),...(mesh.extras?.canonicalId?[mesh.extras.canonicalId]:[])]))].sort();
      ids(actualIds,true);if(!actualIds.every(id=>owners.includes(id))||asset.canonicalIds!==undefined&&!same(ids(asset.canonicalIds,true),actualIds)
        ||isCell&&asset.canonicalIds===undefined)fail('GLB canonical ownership mismatch');tileOwners.set(asset.uri,actualIds);
    }
    descriptor(manifest.tileset,L.tilesetBytes,known);descriptor(manifest.semantics,L.semanticsBytes,known);
    if(manifest.tileset.uri!=='tileset.json'||manifest.semantics.uri!=='semantics.json')fail('pack metadata path invalid');
    const tileset=parsed(await take(base+'tileset.json',manifest.tileset,L.tilesetBytes,'tileset'),'tileset'),used=new Set();
    function visit(node){
      if(!object(node)||node.refine!=='REPLACE'||!object(node.content)||!tileOwners.has(node.content.uri)||used.has(node.content.uri))fail('tileset GLB closure incomplete or duplicate');
      used.add(node.content.uri);if(used.size>64)fail('tileset node budget exceeded');const own=tileOwners.get(node.content.uri);
      if(node.children!==undefined){if(!Array.isArray(node.children)||!node.children.length)fail('tileset child closure invalid');const childIds=node.children.flatMap(visit).sort();if(!same(childIds,own))fail('REPLACE ownership partition incomplete or duplicate');}return own;
    }
    if(!same(visit(tileset.root),owners)||used.size!==tileOwners.size)fail('tileset ownership closure incomplete');
    const semantics=parsed(await take(base+'semantics.json',manifest.semantics,L.semanticsBytes,'semantics'),'semantics');
    if(semantics.contract!=='CityVisualSemanticsV1'||semantics.sourceDatasetVersion!==lineage.datasetVersion||!object(semantics.buildings)
      ||!same(Object.keys(semantics.buildings).sort(),owners))fail('semantics canonical closure incomplete');
    sourceAttribution(manifest,known);noUnknownAssets(manifest,known);
  }
  await pack('manifest.json',root,null,false);
  const allIds=new Set(),keys=new Set(),paths=new Set();
  for(const cell of catalog.cells){
    if(typeof cell.key!=='string'||!/^[-a-z0-9_]{1,80}$/.test(cell.key)||keys.has(cell.key))fail('duplicate catalog cell');keys.add(cell.key);
    const own=ids(cell.canonicalIds);for(const id of own){if(allIds.has(id))fail('duplicate catalog canonical ownership');allIds.add(id);if(allIds.size>L.canonicalIds)fail('catalog canonical ownership budget exceeded');}
    descriptor(cell.manifest,L.cellBytes,known);
    if(cell.manifest.uri!==`cells/${cell.key}/${cell.manifest.sha256}/manifest.json`||paths.has(cell.manifest.uri))fail('cell manifest path or duplicate invalid');paths.add(cell.manifest.uri);
    const path=catalogBase+cell.manifest.uri,bytes=await take(path,cell.manifest,L.cellBytes,'cell_manifest');
    await pack(path,parsed(bytes,'cell manifest'),own,true);manifestOrder.push(path);
  }
  if(requireComplete&&!root.populationCompatibility.canonicalIds.every(id=>allIds.has(id)))fail('complete catalog omits root canonical ownership');
  noUnknownAssets(catalog,known);manifestOrder.push(catalogPath,'manifest.json');
  return {files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path)),manifestOrder,root:{bytes:rootBytes.length,sha256:hash(rootBytes)},
    catalog:{path:catalogPath,bytes:catalogBytes.length,sha256:hash(catalogBytes),coverage:catalog.coverage},lineage,populationDatasetId,totalBytes};
}
