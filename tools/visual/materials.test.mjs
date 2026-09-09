import test from 'node:test';
import assert from 'node:assert/strict';
import {materialDefinition} from './materials.mjs';
test('grass intentionally uses rough solid linear-color fallback instead of stretched atlas pixels',()=>{
 const def=materialDefinition('grass',true),pbr=def.pbrMetallicRoughness;
 assert.equal(pbr.baseColorTexture,undefined);assert.equal(pbr.roughnessFactor,1);assert.equal(pbr.baseColorFactor[3],1);
 assert.ok(pbr.baseColorFactor.slice(0,3).every(v=>v>0&&v<.4));
 assert.equal(def.extras.albedoFallback,'solid_muted_green_with_analytic_vertex_variation_until_metric_tiling');
 assert.deepEqual(materialDefinition('brick',true).pbrMetallicRoughness.baseColorTexture,{index:0});
});
