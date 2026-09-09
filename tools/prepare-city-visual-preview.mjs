/** Copy ONLY the verified quarter manifest inventory, never stale GLBs or full-city data. */
import {readFile,copyFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {replacePreviewManifest} from './visual/atomic-preview-write.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
if(args.length&&!(args.length===2&&args[0]==='--source-cache'))throw Error('Expected only --source-cache CACHE_DIRECTORY');
const source=resolve(root,args[1]??'.cache/city-visual-v1'),target=resolve(root,'apps/web/public/city-visual-v1');
if(!source.startsWith(resolve(root,'.cache')+sep))throw Error('Preview source must stay within the demo cache');
const bytes=await readFile(resolve(source,'manifest.json')),manifest=JSON.parse(bytes);
if(manifest.contract!=='CityVisualPackManifestV1'||manifest.coverage!=='bounded_quarter')throw Error('Only a verified bounded quarter may enter local preview');
const inventory=[manifest.tileset,manifest.semantics,...manifest.assets,...manifest.textureAssets,...(manifest.materialLibrary?.assets??[])];
for(const asset of inventory){
  if(!asset||typeof asset.uri!=='string'||asset.uri.startsWith('/')||asset.uri.split('/').some(p=>p==='..'||p==='.'||!p))throw Error('Invalid inventory path');
  const from=resolve(source,asset.uri),to=resolve(target,asset.uri);
  if(!from.startsWith(source+sep)||!to.startsWith(target+sep))throw Error('Asset escaped preview roots');
  const body=await readFile(from);
  if(body.length!==asset.bytes||createHash('sha256').update(body).digest('hex')!==asset.sha256)throw Error(`Asset integrity failed: ${asset.uri}`);
}
for(const asset of inventory){const to=resolve(target,asset.uri);await mkdir(dirname(to),{recursive:true});await copyFile(resolve(source,asset.uri),to);}
await writeFile(resolve(target,'manifest.json.next'),bytes);
const atomicReplaceMethod=await replacePreviewManifest(resolve(target,'manifest.json.next'),resolve(target,'manifest.json'));
console.log(JSON.stringify({previewOnly:true,assets:inventory.length,bytes:inventory.reduce((s,a)=>s+a.bytes,0),manifestSha256:createHash('sha256').update(bytes).digest('hex'),atomicReplaceMethod}));
