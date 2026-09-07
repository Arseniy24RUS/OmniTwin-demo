import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';
const directory=resolve(import.meta.dirname,'../../apps/web/public/city-v2');
const available=existsSync(resolve(directory,'manifest.json'));
const hash=b=>createHash('sha256').update(b).digest('hex');
function asset(a){const b=readFileSync(resolve(directory,a.url));assert.equal(b.length,a.bytes);assert.equal(hash(b),a.sha256);return JSON.parse(b);}
test('real city pack has seven dated source districts and no imported population',{skip:!available},()=>{
  const m=JSON.parse(readFileSync(resolve(directory,'manifest.json')));
  assert.equal(m.contract,'DemoCityPackManifestV2');assert.equal(m.coverage.districtIds.length,7);
  assert.equal(m.semantics.populationTagsImported,false);assert.ok(m.coverage.buildings>10000);
  const boundaries=asset(m.boundaries);assert.equal(boundaries.features.length,8);
  assert.ok(boundaries.features.every(f=>f.properties.sourceVersion&&f.properties.sourceTimestamp));
  assert.ok(m.coverage.districts.every(d=>d.residentialBuildingCount>0));
  const index=asset(m.buildingIndex);assert.equal(index.rows.length,m.buildingIndex.count);
  assert.equal(new Set(index.rows.map(r=>r[0])).size,index.rows.length);
  assert.ok(index.rows.every(r=>r[4]!=='mixed'));
  assert.ok(index.rows.filter(r=>r[4]==='unknown').every(r=>r[8]===0));
  const inspected=index.rows.find(r=>r[0]==='openmaptiles_buildings:591780650');
  assert.equal(inspected[4],'study');assert.equal(inspected[6],4);
  assert.ok(inspected[10].includes('openmaptiles_buildings:591780652'));
});
test('representative real cells are small, immutable and gzip-equivalent',{skip:!available},()=>{
  const m=JSON.parse(readFileSync(resolve(directory,'manifest.json')));
  assert.equal(new Set(m.cells.map(c=>c.key)).size,m.cells.length);
  assert.ok(m.cells.every(c=>c.bytes<2*1024*1024));
  for(const c of [m.cells[0],m.cells[Math.floor(m.cells.length/2)],m.cells.at(-1),m.cells.reduce((a,b)=>a.bytes>b.bytes?a:b)]){
    const data=asset(c),gzip=readFileSync(resolve(directory,c.gzip.url));
    assert.equal(gzip.length,c.gzip.bytes);assert.equal(hash(gzip),c.gzip.sha256);assert.equal(hash(gunzipSync(gzip)),c.sha256);
    assert.equal(data.key,c.key);assert.equal(data.buildings.length,c.buildingCount);assert.equal(data.roads.length,c.roadCount);
    assert.equal(new Set(data.buildings.map(b=>b.id)).size,data.buildings.length);
    assert.ok(data.roads.every(r=>r.coordinates.length>=2&&r.nodeIds.length===r.coordinates.length));
  }
});
