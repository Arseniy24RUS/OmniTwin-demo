import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve('apps/web/dist');
async function walk(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(async x=>x.isDirectory()?walk(join(dir,x.name)):[join(dir,x.name)]))).flat()}
const files=await walk(root);
for(const file of files){
  assert(!/\.(parquet|env|pem|key|zip)$/i.test(file),`Unexpected public file ${file}`);
  if(!/\.(js|json|html|css|txt)$/i.test(file))continue;
  const source=await readFile(file,'utf8');
  assert(!/sk-or-v1-[a-f0-9]{24,}/i.test(source),`OpenRouter key in ${file}`);
  assert(!/AIza[0-9A-Za-z_-]{30,}/.test(source),`Google key in ${file}`);
  assert(!/gh[pousr]_[A-Za-z0-9]{30,}/.test(source),`GitHub key in ${file}`);
  assert(!/C:\\\\Users\\\\|D:\\\\Codex\\\\/.test(source),`Local filesystem path in ${file}`);
}
const config=JSON.parse(await readFile(join(root,'runtime-config.json'),'utf8'));
assert(config.chatApiUrl===null||new URL(config.chatApiUrl).protocol==='https:','Public chat must use HTTPS');
const manifest=JSON.parse(await readFile(join(root,'demo/manifest.json'),'utf8'));
assert.equal(manifest.scientificClaim,false);assert.equal(manifest.predictiveValidation,false);
console.log(`Public build checked: ${files.length} files; fictional-data flags present; no recognized embedded keys.`);
