import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBuilding} from './buildings.mjs';
import {roofFixtures} from './building-details.mjs';
import {projectLocal} from './geometry.mjs';
import {metricUVs} from './glb.mjs';

const origin=[61.39466,55.1654,0],unit=projectLocal([origin[0]+1,origin[1]+1],origin);
const geo=([x,y])=>[origin[0]+x/unit[0],origin[1]+y/unit[1]];
const rectangle=(w,h)=>[[0,0],[w,0],[w,h],[0,h],[0,0]];
const source={id:'art-v3-panel',sourceClass:'apartments',heightM:27,levels:9,sourceAttributes:{building:'apartments'},footprint:{type:'Polygon',coordinates:[rectangle(60,180).map(geo)]}};

test('large roof equipment covers its full length, varies form and has bounded near/coarse cost',()=>{
  const polygons=[[rectangle(60,180).slice(0,-1)]],near=roofFixtures(source.id,polygons,27,{family:'panel',lod:0}),far=roofFixtures(source.id,polygons,27,{family:'panel',lod:1});
  assert.ok(near.placements.length>=12&&near.placements.length<=24);
  assert.ok(new Set(near.placements.map(p=>p.kind)).size>=3);
  assert.ok(Math.max(...near.placements.map(p=>p.center[1]))-Math.min(...near.placements.map(p=>p.center[1]))>140);
  assert.ok(far.placements.length<=8);assert.ok(far.mesh.indices.length/3<=240);assert.ok(near.mesh.indices.length/3<=2400);
  for(const p of far.placements)assert.ok(near.placements.some(n=>n.center[0]===p.center[0]&&n.center[1]===p.center[1]));
  assert.deepEqual(near,roofFixtures(source.id,polygons,27,{family:'panel',lod:0}));
});

test('roof equipment complete envelopes and caps stay inside actual holes and boundaries',()=>{
  const outer=rectangle(60,180).slice(0,-1),hole=[[18,40],[18,140],[42,140],[42,40]],result=roofFixtures(source.id,[[outer,hole]],27,{family:'panel'});
  assert.ok(result.placements.length>8);
  for(const p of result.placements){assert.ok(p.envelopeCorners.length===4);assert.equal(p.representation,'visual_synthesis');assert.ok(p.topM<=29);
    for(const[x,y]of p.envelopeCorners){assert.ok(x>=1&&x<=59&&y>=1&&y<=179);assert.ok(x<18||x>42||y<40||y>140);}}
});

test('close facade has bounded true recesses, distinct family profiles and source-invariant roof parapets',()=>{
  const snapshot=JSON.stringify(source),near=buildBuilding(source,{origin}),far=buildBuilding(source,{origin,lod:1}),grammar=near.metadata.appearance.facadeGrammar;
  assert.equal(grammar.version,4);assert.ok(grammar.deepWindowCount>0&&grammar.deepWindowCount<=48);assert.equal(far.metadata.appearance.facadeGrammar.deepWindowCount,0);
  assert.ok(grammar.windowVariantCounts.filter(n=>n>0).length>=3);assert.ok(grammar.bandCount<=64);
  assert.deepEqual(near.metadata.footprint,source.footprint);assert.equal(near.metadata.sourceHeightM,27);assert.equal(JSON.stringify(source),snapshot);
  const profiles=['apartments','brick','school','industrial','house'].map(kind=>buildBuilding({...source,sourceClass:kind,sourceAttributes:{building:kind}},{origin}).metadata.appearance.facadeGrammar.windowProfile);
  assert.ok(new Set(profiles.map(JSON.stringify)).size>=4);
  const trim=near.meshes.find(m=>m.name.endsWith(':trim'));assert.ok(trim.positions.some((y,i)=>i%3===1&&y>27.25&&y<27.6),'a real parapet rises above the source roof plane');
  const glass=near.meshes.filter(m=>m.name.endsWith(':windows')||m.name.endsWith(':windowLight'));assert.ok(glass.some(m=>m.positions.some((z,i)=>i%3===2&&z<-.1&&z>-.3)),'glass on south source edge is truly behind its source wall');
  const shell=near.meshes.find(m=>m.name.endsWith(':shell'));let tested=0;
  const inside=(p,t)=>{const signs=t.map((a,i)=>{const b=t[(i+1)%3];return(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);});return signs.every(v=>v>1e-8)||signs.every(v=>v< -1e-8);};
  for(const m of glass)for(let i=0;i<m.positions.length;i+=18){const a=m.positions.slice(i,i+3),b=m.positions.slice(i+3,i+6),c=m.positions.slice(i+6,i+9);if(a[2]<-.1&&a[2]>-.3&&a[0]>0&&a[0]<60){
    const p=[(a[0]+b[0]+c[0])/3,(a[1]+b[1]+c[1])/3];tested++;
    for(let j=0;j<shell.positions.length;j+=9){const t=[0,3,6].map(k=>shell.positions.slice(j+k,j+k+3));if(t.every(v=>Math.abs(v[2])<1e-8))assert.equal(inside(p,t),false,'source wall must not occlude recessed glass');}
  }}assert.ok(tested>0);
  for(const m of near.meshes)assert.equal(m.canonicalId,source.id);
});

test('new roof and facade detail uses existing metric material scale without stretched UV cards',()=>{
  const result=buildBuilding(source,{origin});
  for(const name of ['roofFixtures','windowReveals','trim']){const m=result.meshes.find(m=>m.name.endsWith(`:${name}`));assert.ok(m);
    const uv=metricUVs(m,[2,2]);assert.ok(uv.every(Number.isFinite));
    for(let i=0;i<m.positions.length;i+=9){const distance=Math.hypot(...m.positions.slice(i+3,i+6).map((v,j)=>v-m.positions[i+j]));const ud=Math.hypot(uv[(i/3+1)*2]-uv[i/3*2],uv[(i/3+1)*2+1]-uv[i/3*2+1]);assert.ok(Math.abs(ud*2-distance)<1e-6);}}
});
