import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCourtyards } from './courtyards.mjs';
test('opaque tree crowns face outward above and below, only inside actual courtyard holes',()=>{
  const outer=[[61.39,55.16],[61.40,55.16],[61.40,55.17],[61.39,55.17],[61.39,55.16]],hole=[[61.392,55.162],[61.398,55.162],[61.398,55.168],[61.392,55.168],[61.392,55.162]];
  const b={id:'courtyard-fixture',footprint:{type:'Polygon',coordinates:[outer,hole]}},r=buildCourtyards([b],{origin:[61.395,55.165]});assert.ok(r.diagnostics.trees>0);assert.ok(r.diagnostics.trees<=6);const leaves=r.meshes.find(m=>m.material==='leaves');for(let i=0;i<leaves.normals.length;i+=18){assert.ok(leaves.normals[i+1]>0,'top outward/up');assert.ok(leaves.normals[i+10]<0,'bottom outward/down');}
  assert.equal(buildCourtyards([{...b,footprint:{type:'Polygon',coordinates:[outer]}}],{origin:[61.395,55.165]}).diagnostics.trees,0);
});
