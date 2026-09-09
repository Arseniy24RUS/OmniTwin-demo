import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBuildingIds,materialLibraryFromKit,detailGridCell } from './compiler-materials.mjs';

test('GLB ownership manifest comes from actual native picking triangle ranges',()=>{
  const meshes=[{featureRanges:[{canonicalId:'openmaptiles_buildings:22'},{canonicalId:'openmaptiles_buildings:11'}]},{featureRanges:[{canonicalId:'openmaptiles_buildings:22'}],sourceIds:['not-a-building']},{sourceIds:['tree'],featureRanges:[]}];
  assert.deepEqual(canonicalBuildingIds(meshes),['openmaptiles_buildings:11','openmaptiles_buildings:22']);
  assert.deepEqual(canonicalBuildingIds([{featureRanges:[]}]),[]);
});
test('detail grid boundaries assign each canonical building or tree to one cell',()=>{
  assert.deepEqual(detailGridCell([-600,-600],1200,4),[0,0]);
  assert.deepEqual(detailGridCell([0,0],1200,4),[2,2]);
  assert.deepEqual(detailGridCell([600,601],1200,4),[3,3]);
  assert.deepEqual(detailGridCell([-900,0],1200,4),[0,2]);
});
test('material library preserves pinned sources and metric family assignments without legacy atlas mutation',()=>{
  const kit={assets:[{uri:'materials/wall.jpg',sha256:'a'.repeat(64),bytes:10,role:'baseColor'}],materialTextures:{brick:{baseColorUri:'../materials/wall.jpg',repeatMeters:[1.5,1.5]}},provenance:{licenseUrl:'https://polyhaven.com/license'}};
  const result=materialLibraryFromKit(kit,'b'.repeat(64));
  assert.equal(result.contract,'CityMaterialLibraryV2');assert.equal(result.mode,'metric_repeat');
  assert.equal(result.sourceCatalogSha256,'b'.repeat(64));assert.deepEqual(result.assets,kit.assets);assert.deepEqual(result.materials,kit.materialTextures);
  assert.equal(result.representation,'visual_synthesis');
});
