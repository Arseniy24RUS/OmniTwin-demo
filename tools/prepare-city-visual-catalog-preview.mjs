/** Publish a hash-verified local catalog inventory then atomically update its preview pointer. */
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {replacePreviewManifest} from './visual/atomic-preview-write.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),input=resolve(root,process.argv[2]??'');
if(!input.startsWith(resolve(root,'.cache')+sep)||!input.endsWith('.json'))throw Error('Expected a catalog JSON inside the demo cache');
const bytes=await readFile(input),catalog=JSON.parse(bytes),hash=b=>createHash('sha256').update(b).digest('hex');
if(catalog.contract!=='CityVisualCatalogV1')throw Error('Invalid catalog contract');
const source=dirname(input),version=source.split(sep).at(-1),base=resolve(root,'apps/web/public/city-visual-v1');
if(!/^build-[a-f0-9]+$/.test(version))throw Error('Expected immutable catalog build directory');
const target=resolve(base,'catalog',version),inventory=new Map();
const readAsset=async descriptor=>{
 const uri=descriptor.uri;
 if(typeof uri!=='string'||uri.split('/').some(p=>!p||p==='.'||p==='..')||uri.startsWith('/'))throw Error('Unsafe catalog asset path');
 const path=resolve(source,uri);if(!path.startsWith(source+sep))throw Error('Asset escaped catalog source');
 const data=await readFile(path);if(data.length!==descriptor.bytes||hash(data)!==descriptor.sha256)throw Error(`Catalog asset integrity failed: ${uri}`);
 inventory.set(uri,descriptor);return data;
};
for(const asset of catalog.materialLibrary?.assets??[])await readAsset(asset);
for(const cell of catalog.cells){
 const body=await readAsset(cell.manifest),manifest=JSON.parse(body),prefix=cell.manifest.uri.slice(0,-'manifest.json'.length);
 if(manifest.source.datasetVersion!==catalog.source.datasetVersion)throw Error('Catalog source mismatch');
 for(const asset of [manifest.tileset,manifest.semantics,...manifest.assets,...manifest.textureAssets])await readAsset({...asset,uri:prefix+asset.uri});
}
for(const [uri] of inventory){const path=resolve(target,uri);if(!path.startsWith(target+sep))throw Error('Asset escaped preview');await mkdir(dirname(path),{recursive:true});await copyFile(resolve(source,uri),path);}
await mkdir(target,{recursive:true});const catalogName=`catalog-${hash(bytes).slice(0,16)}.json`;await writeFile(resolve(target,catalogName),bytes);
const manifestPath=resolve(base,'manifest.json'),manifest=JSON.parse(await readFile(manifestPath));
if(manifest.source.datasetVersion!==catalog.source.datasetVersion)throw Error('Preview and catalog source mismatch');
manifest.visualCatalog={uri:`catalog/${version}/${catalogName}`,bytes:bytes.length,sha256:hash(bytes)};
await writeFile(manifestPath+'.next',JSON.stringify(manifest,null,2)+'\n');await replacePreviewManifest(manifestPath+'.next',manifestPath);
console.log(JSON.stringify({previewOnly:true,coverage:catalog.coverage,assets:inventory.size,catalogSha256:hash(bytes)}));
