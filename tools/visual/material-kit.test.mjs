import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FAMILY_SOURCES,jpegDimensions,prepareMaterialKit } from './material-kit.mjs';

test('pinned CC0 source catalog is bounded, reproducible and uses separate PBR channels',async()=>{
  const catalog=JSON.parse(await readFile(new URL('./assets/polyhaven-materials-v1.json',import.meta.url),'utf8'));
  assert.equal(catalog.length,21);assert.equal(new Set(catalog.map(d=>d.sourceId)).size,7);
  assert.equal(new Set(catalog.map(d=>d.sha256)).size,21);
  assert.ok(catalog.reduce((n,d)=>n+d.bytes,0)<12*1024*1024);
  for(const d of catalog){assert.equal(d.license,'CC0-1.0');assert.match(d.sha256,/^[a-f0-9]{64}$/);assert.equal(d.colorSpace,d.role==='baseColor'?'sRGB':'linear');assert.equal(new URL(d.sourceUrl).hostname,'dl.polyhaven.org');}
  for(const id of new Set(catalog.map(d=>d.sourceId)))assert.deepEqual(catalog.filter(d=>d.sourceId===id).map(d=>d.role),['baseColor','normal','orm']);
});
test('material importer rejects a destination outside the cache before downloading',async()=>{
  let downloads=0;
  await assert.rejects(prepareMaterialKit('tools/visual/assets',{fetcher:()=>{downloads++;}}),/inside repo/);
  assert.equal(downloads,0);
});
test('JPEG header dimensions require a real bounded frame header',()=>{
  const bytes=Buffer.from([255,216,255,192,0,11,8,4,0,4,0,3,1,17,0,255,217]);
  assert.deepEqual(jpegDimensions(bytes),{width:1024,height:1024});
  assert.throws(()=>jpegDimensions(Buffer.from('invalid')),/JPEG/);
});
test('facades and structural plinths use pale plaster while weathered floor remains paving-only',()=>{
  for(const family of ['panel','neutral','civic','concrete'])assert.equal(FAMILY_SOURCES[family][0],'plastered_wall_02');
  assert.equal(FAMILY_SOURCES.paving[0],'concrete_floor_02');
  assert.equal(FAMILY_SOURCES.brick[0],'brick_wall_001');
});
