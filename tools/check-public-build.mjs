import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const root=resolve('apps/web/dist');
async function walk(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(async x=>x.isDirectory()?walk(join(dir,x.name)):[join(dir,x.name)]))).flat()}
const files=await walk(root);
assert(!files.some(file=>/[/\\](city-v2|demo-v2)[/\\]/.test(file)), 'Large city assets must be deployed to the dedicated Storage pack, not Pages');
let totalBytes=0;
for(const file of files){
  totalBytes+=(await stat(file)).size;
  assert(!/\.(parquet|env|pem|key|zip)$/i.test(file),`Unexpected public file ${file}`);
  if(!/\.(js|json|html|css|txt)$/i.test(file))continue;
  const source=await readFile(file,'utf8');
  assert(!/sk-or-v1-[a-f0-9]{24,}/i.test(source),`OpenRouter key in ${file}`);
  assert(!/AIza[0-9A-Za-z_-]{30,}/.test(source),`Google key in ${file}`);
  assert(!/gh[pousr]_[A-Za-z0-9]{30,}/.test(source),`GitHub key in ${file}`);
  assert(!/C:\\\\Users\\\\|D:\\\\Codex\\\\/.test(source),`Local filesystem path in ${file}`);
}
assert(totalBytes<128*1024*1024,'Pages shell exceeds the 128 MiB demo budget');
const config=JSON.parse(await readFile(join(root,'runtime-config.json'),'utf8'));
assert(config.chatApiUrl===null||new URL(config.chatApiUrl).protocol==='https:','Public chat must use HTTPS');
const manifest=JSON.parse(await readFile(join(root,'demo/manifest.json'),'utf8'));
assert.equal(manifest.scientificClaim,false);assert.equal(manifest.predictiveValidation,false);
const observedAsset=manifest.assets.observedCity;
assert(observedAsset?.url==='observed-chelyabinsk-v1.json','Independent observed reference must be manifest-bound');
const observedBytes=await readFile(join(root,'demo',observedAsset.url));
assert.equal(observedBytes.byteLength,observedAsset.bytes);
assert.equal(createHash('sha256').update(observedBytes).digest('hex'),observedAsset.sha256);
const observed=JSON.parse(observedBytes.toString('utf8'));
assert.equal(observed.representation,'observed_reference');
assert.equal(observed.territory.oktmo,'75701000');
assert(!/registry_declared|raw\.pmo|localPath|sourceRows/.test(observedBytes.toString('utf8')),'Private source audit must not be deployed');
console.log(`Public build checked: ${files.length} files, ${totalBytes} bytes; observed/fictional sources separated; no recognized embedded keys.`);
