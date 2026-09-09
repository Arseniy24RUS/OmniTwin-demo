import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCourtyardDetails,COURTYARD_LIMITS } from './courtyard-details.mjs';
import { pointInRing } from '../geo/city-geography.mjs';

const ring=[[-45,-45],[45,-45],[45,45],[-45,45]];
const area={key:'building-hole:123:0',sourceIds:['openmaptiles_buildings:123'],kind:'courtyard_hole',rings:[ring]};
const options={boundsMeters:[-100,-100,100,100],isBlocked:()=>false,maxDecorations:24};
test('courtyard benches and planters stay bounded, deterministic and explicitly illustrative',()=>{
  const result=buildCourtyardDetails([area],options);
  assert.ok(result.placements.length>1&&result.placements.length<=COURTYARD_LIMITS.perArea);
  assert.ok(result.placements.some(p=>p.kind==='bench')&&result.placements.some(p=>p.kind==='planter'));
  assert.deepEqual(result,buildCourtyardDetails([area],options));
  for(const p of result.placements){assert.equal(p.provenance,'visual_synthesis');assert.equal(p.areaKind,'courtyard_hole');assert.deepEqual(p.sourceIds,area.sourceIds);for(const corner of p.corners)assert.ok(pointInRing(corner,ring));}
  for(const m of result.meshes){assert.equal(m.canonicalId,null);assert.ok(m.decorationId);assert.ok(m.positions.every(Number.isFinite));assert.equal(m.positions.length,m.normals.length);}
  assert.ok(result.meshes.reduce((n,m)=>n+m.positions.length/3,0)<=COURTYARD_LIMITS.vertices);
});
test('entire detail footprint avoids concave boundaries, polygon holes and source road clearances',()=>{
  const lShape=[[-45,-45],[45,-45],[45,-5],[-5,-5],[-5,45],[-45,45]],hole=[[-32,-32],[-20,-32],[-20,-20],[-32,-20]];
  const result=buildCourtyardDetails([{...area,rings:[lShape,hole]}],{...options,isBlocked:(p,radius)=>Math.abs(p[1]+15)<4+radius});
  assert.ok(result.placements.length>0);
  for(const p of result.placements){assert.ok(Math.abs(p.point[1]+15)>=4+p.radiusMeters);for(const c of p.corners){assert.ok(pointInRing(c,lShape));assert.ok(!pointInRing(c,hole));}}
});
test('caps are global and duplicate source areas cannot create duplicate furniture',()=>{
  const areas=Array.from({length:40},(_,i)=>({...area,key:`area-${String(i).padStart(2,'0')}`}));
  const a=buildCourtyardDetails([...areas,...areas],{...options,maxDecorations:7});
  assert.equal(a.placements.length,7);assert.deepEqual(a,buildCourtyardDetails([...areas,...areas].reverse(),{...options,maxDecorations:7}));
  assert.equal(new Set(a.placements.map(p=>p.point.join(':'))).size,a.placements.length);
  assert.ok(a.diagnostics.attempts<=COURTYARD_LIMITS.attempts);
  assert.equal(buildCourtyardDetails([area],{...options,maxDecorations:0}).placements.length,0);
  assert.equal(buildCourtyardDetails([area],{...options,isBlocked:()=>true}).placements.length,0);
});
test('unknown source areas do not invent a courtyard or park',()=>{
  assert.throws(()=>buildCourtyardDetails([{...area,kind:'open_ground'}],options),/source area/i);
  assert.throws(()=>buildCourtyardDetails([area],{...options,isBlocked:undefined}),/exclusion/i);
});
