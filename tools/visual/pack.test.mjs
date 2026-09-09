import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTileset } from './pack.mjs';
import { batchMeshes } from './batching.mjs';
test('REPLACE hierarchy has ECEF root, local metre bounding boxes and no simultaneous parent ownership',()=>{
  const tiles=makeTileset({origin:[61.39466,55.1654,0],bounds:[61.38,55.15,61.41,55.18],coarse:{uri:'tiles/coarse.glb',box:[0,25,0,600,0,0,0,600,0,0,0,25]},children:[{uri:'tiles/near.glb',box:[0,25,0,300,0,0,0,300,0,0,0,25]}]});
  assert.equal(tiles.asset.version,'1.1');assert.equal(tiles.root.refine,'REPLACE');assert.equal(tiles.root.children[0].geometricError,0);assert.ok(Math.hypot(...tiles.root.transform.slice(12,15))>6e6);assert.equal(tiles.root.extras.coordinateSystem,'east-up-south');assert.equal(tiles.root.content.uri,'tiles/coarse.glb');
  assert.equal(tiles.root.geometricError,2,'authored coarse omission bound must survive delivery without a runtime catalog allowlist');
});
test('batching retains exact raycast ranges and attributes',()=>{
  const source=id=>({name:id,canonicalId:id,material:'brick',positions:[0,0,0,1,0,0,0,1,0],normals:[0,0,1,0,0,1,0,0,1],uvs:[0,0,1,0,0,1],indices:[0,1,2]});
  const [m]=batchMeshes([source('one'),source('two')]);assert.deepEqual(m.featureRanges,[{firstTriangle:0,triangleCount:1,canonicalId:'one'},{firstTriangle:1,triangleCount:1,canonicalId:'two'}]);assert.deepEqual(m.indices,[0,1,2,3,4,5]);assert.equal(m.colors.length,m.positions.length);
});
