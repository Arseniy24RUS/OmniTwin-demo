import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPublicShell } from '../copy-public-shell.mjs';

test('Pages shell excludes generated city/population packs but preserves legacy and UI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnitwin-public-shell-'));
  const source = join(directory, 'public'); const output = join(directory, 'dist');
  for (const name of ['city-v2', 'demo-v2', 'city-visual-v1', 'demo', 'textures']) {
    await mkdir(join(source, name), { recursive: true }); await writeFile(join(source, name, 'fixture.json'), '{}');
  }
  await writeFile(join(source, 'runtime-config.json'), '{}');
  await copyPublicShell(source, output);
  assert.deepEqual((await readdir(output)).sort(), ['demo', 'runtime-config.json', 'textures']);
  await assert.rejects(copyPublicShell(source, source), /must differ/);
});

async function actorFixture(binaryUrl) {
  const directory=await mkdtemp(join(tmpdir(),'omnitwin-actor-shell-')),source=join(directory,'public'),output=join(directory,'dist');
  const pack=join(source,'assets/game-actors-v1');await mkdir(pack,{recursive:true});
  await writeFile(join(pack,'actors.bin'),'retained legacy actor bytes');
  if(binaryUrl){
    if(binaryUrl!=='actors.bin')await writeFile(join(pack,binaryUrl),'current actor bytes');
    const bytes=await readFile(join(pack,binaryUrl));
    await writeFile(join(pack,'manifest.json'),JSON.stringify({contractVersion:1,binary:{url:binaryUrl,bytes:bytes.length,
      sha256:createHash('sha256').update(bytes).digest('hex')}}));
  }
  for(const name of ['kenney-license.txt','quaternius-men-license.txt','quaternius-women-license.txt','provenance.json'])await writeFile(join(pack,name),name);
  return {source,output,pack,outputPack:join(output,'assets/game-actors-v1')};
}

test('Pages shell omits only the unreferenced legacy actor binary and preserves source/current pack/provenance',async()=>{
  const fixture=await actorFixture('actors-current.bin');
  await mkdir(join(fixture.source,'assets/other'),{recursive:true});
  await writeFile(join(fixture.source,'assets/other/actors.bin'),'unrelated binary');
  await copyPublicShell(fixture.source,fixture.output);
  assert.deepEqual((await readdir(fixture.outputPack)).sort(),['actors-current.bin','kenney-license.txt','manifest.json','provenance.json','quaternius-men-license.txt','quaternius-women-license.txt']);
  assert.equal(await readFile(join(fixture.pack,'actors.bin'),'utf8'),'retained legacy actor bytes');
  assert.equal(await readFile(join(fixture.outputPack,'actors-current.bin'),'utf8'),'current actor bytes');
  assert.equal(await readFile(join(fixture.output,'assets/other/actors.bin'),'utf8'),'unrelated binary');
});

test('Pages shell retains actors.bin when its manifest references it or no manifest exists',async()=>{
  for(const binaryUrl of ['actors.bin',null]){
    const fixture=await actorFixture(binaryUrl);await copyPublicShell(fixture.source,fixture.output);
    assert.equal(await readFile(join(fixture.outputPack,'actors.bin'),'utf8'),'retained legacy actor bytes');
  }
});

test('Pages shell preserves legacy bytes when a different binary is not verifiably available',async()=>{
  for(const manifest of ['invalid-json',JSON.stringify({contractVersion:1,binary:{url:'missing.bin',bytes:8,sha256:'a'.repeat(64)}}),
    JSON.stringify({contractVersion:1,binary:{url:'./actors.bin',bytes:27,sha256:'a'.repeat(64)}})]){
    const fixture=await actorFixture(null);await writeFile(join(fixture.pack,'manifest.json'),manifest);
    await copyPublicShell(fixture.source,fixture.output);
    assert.equal(await readFile(join(fixture.outputPack,'actors.bin'),'utf8'),'retained legacy actor bytes');
  }
  const corrupt=await actorFixture('actors-current.bin');
  await writeFile(join(corrupt.pack,'actors-current.bin'),'damaged actor bytes');
  await copyPublicShell(corrupt.source,corrupt.output);
  assert.equal(await readFile(join(corrupt.outputPack,'actors.bin'),'utf8'),'retained legacy actor bytes');
});
