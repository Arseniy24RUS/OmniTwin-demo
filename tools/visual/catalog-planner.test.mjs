import test from 'node:test';
import assert from 'node:assert/strict';
import { planCatalogJobs, ownedBuildings, tileBounds, ownerCellKey, catalogRootBoundingVolume } from './catalog-planner.mjs';

const id = n => `openmaptiles_buildings:${n}0`;
const building = (n, center) => ({ id: id(n), center, heightM: 12, footprint: { type: 'Polygon', coordinates: [[[center[0]-.0001,center[1]-.0001],[center[0]+.0001,center[1]-.0001],[center[0]+.0001,center[1]+.0001],[center[0]-.0001,center[1]-.0001]]] } });
function manifest() {
  const cells = [[43944,20672],[43945,20672],[43946,20672]].map(([x,y]) => ({ key:`16/${x}/${y}`,bbox:tileBounds(16,x,y),buildingCount:2,roadCount:0,bytes:500,url:`cells/${x}.json`,sha256:'a'.repeat(64) }));
  return { contract:'DemoCityPackManifestV2',cellZoom:16,datasetVersion:'b'.repeat(64),bounds:[61,55,62,56],cells };
}
test('z15 jobs partition every verified source cell once with bounded deterministic descriptors',()=>{
  const source=manifest(), jobs=planCatalogJobs(source);
  assert.equal(jobs.length,2);assert.deepEqual(jobs.flatMap(j=>j.sourceCells.map(c=>c.key)).sort(),source.cells.map(c=>c.key).sort());
  assert.deepEqual(planCatalogJobs({...source,cells:source.cells.toReversed()}),jobs);
  assert.ok(jobs.every(j=>j.sourceCells.length<=4));
  assert.throws(()=>planCatalogJobs({...source,cells:[...source.cells,source.cells[0]]}),/duplicate/i);
});
test('whole buildings have one center owner despite crossing source-cell and job borders',()=>{
  const jobs=planCatalogJobs(manifest()), left=jobs[0],right=jobs[1];
  const a=building(1,[(left.bounds[0]+left.bounds[2])/2,(left.bounds[1]+left.bounds[3])/2]);
  const b=building(2,[(right.bounds[0]+right.bounds[2])/2,(right.bounds[1]+right.bounds[3])/2]);
  const cells=[{key:'a',buildings:[a,b]},{key:'b',buildings:[a,b]}];
  assert.deepEqual(ownedBuildings(left,cells).map(b=>b.id),[a.id]);
  assert.deepEqual(ownedBuildings(right,cells).map(b=>b.id),[b.id]);
  assert.equal(ownerCellKey(a.center,15),left.key);
  assert.throws(()=>ownedBuildings(left,[...cells,{key:'c',buildings:[{...a,heightM:13}]}]),/conflicting/i);
});
test('planner admits manifest-empty jobs explicitly and rejects oversized source envelopes',()=>{
  const source=manifest();source.cells=source.cells.map(c=>({...c,buildingCount:0}));
  assert.equal(planCatalogJobs(source).length,2);
  assert.throws(()=>planCatalogJobs({...source,cells:[{...source.cells[0],bytes:5*1024*1024}]}),/budget/i);
});
test('catalog ECEF volumes preserve every corner of rotated compiled geometry',()=>{
  const root={boundingVolume:{box:[0,0,5,10,0,0,0,20,0,0,0,5]},transform:[0,1,0,0,-1,0,0,0,0,0,1,0,100,200,300,1]};
  assert.deepEqual(catalogRootBoundingVolume(root),{box:[100,200,305,20,0,0,0,10,0,0,0,5]});
  assert.throws(()=>catalogRootBoundingVolume({...root,transform:[]}),/frame/);
});
