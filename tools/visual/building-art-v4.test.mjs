import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBuilding} from './buildings.mjs';
import {projectLocal} from './geometry.mjs';
import {roofFixtures} from './building-details.mjs';

const origin=[61.4,55.16,0],scale=projectLocal([62.4,56.16],origin);
const geo=([x,y])=>[origin[0]+x/scale[0],origin[1]+y/scale[1]];
const source={id:'openmaptiles_buildings:1139296050',sourceClass:'apartments',heightM:27,levels:9,sourceAttributes:{building:'apartments'},
  footprint:{type:'Polygon',coordinates:[[[0,0],[60,0],[60,180],[0,180],[0,0]].map(geo)]}};
const triangles=result=>result.meshes.reduce((n,m)=>n+m.indices.length/3,0);

test('long apartment roofs get family-scaled sparse ventilation groups across the roof instead of four distant boxes',()=>{
  const polygon=[[[[0,0],[100,0],[100,14],[0,14]]]],near=roofFixtures('roof-density-panel',polygon,30,{family:'panel'}),far=roofFixtures('roof-density-panel',polygon,30,{family:'panel',lod:1});
  assert.ok(near.placements.length>=7&&near.placements.length<=12);
  assert.ok(Math.max(...near.placements.map(p=>p.center[0]))-Math.min(...near.placements.map(p=>p.center[0]))>80);
  assert.ok(far.placements.length<=8&&far.mesh.indices.length/3<=240);
  assert.ok(near.mesh.indices.length/3<=2400);for(const p of near.placements)assert.ok(p.topM<=31.76);
});

test('large apartment facades use sparse true depth and cheap continuous walls, not a box surround per aperture',()=>{
  const near=buildBuilding(source,{origin}),grammar=near.metadata.appearance.facadeGrammar;
  assert.ok(triangles(near)/near.metadata.windowCount<12,'architectural detail must stay below 12 triangles per window including walls/roof/equipment');
  assert.ok(grammar.deepWindowCount>0&&grammar.deepWindowCount<=48);
  assert.equal(grammar.layout.version,4);assert.ok(grammar.stairwellWindowCount>0);
  assert.ok(grammar.windowWidthKinds>=3,'same family needs paired, wider room and narrow stairwell windows');
});
test('window groups are deterministic across LOD and source families without turning apartments into curtain walls',()=>{
  const near=buildBuilding(source,{origin}),far=buildBuilding(source,{origin,lod:1});
  assert.deepEqual(near.metadata.appearance.facadeGrammar.layout,far.metadata.appearance.facadeGrammar.layout);
  assert.deepEqual(near.metadata.footprint,source.footprint);assert.equal(near.metadata.sourceHeightM,source.heightM);
  assert.deepEqual(buildBuilding(source,{origin}),near);
  const widths=new Set();for(const m of near.meshes.filter(m=>['windows','windowLight'].includes(m.material)))for(let i=0;i<m.positions.length;i+=18){
    const p=m.positions,a=p.slice(i,i+3),b=p.slice(i+3,i+6),width=Math.hypot(b[0]-a[0],b[2]-a[2]);
    assert.ok(width>=.64&&width<=2.31);widths.add(width.toFixed(2));
  }assert.ok(widths.size>=3);
  assert.ok(far.metadata.windowCount<=512);
  const familyLayouts=['apartments','school','industrial','commercial','house'].map(kind=>buildBuilding({...source,sourceClass:kind,sourceAttributes:{building:kind}},{origin}).metadata.appearance.facadeGrammar.layout);
  assert.ok(new Set(familyLayouts.map(v=>JSON.stringify(v.pattern))).size>=4);
});
test('commercial source family gets bounded source-edge ground-floor shop glazing and multiple entrances',()=>{
  const building={...source,sourceClass:'commercial',sourceAttributes:{building:'commercial'},heightM:12,levels:4};
  const result=buildBuilding(building,{origin}),grammar=result.metadata.appearance.facadeGrammar;
  assert.ok(grammar.shopfrontCount>0&&grammar.shopfrontCount<=24);
  assert.ok(grammar.entranceCount>=2&&grammar.entranceCount<=8);
  for(const m of result.meshes)assert.equal(m.canonicalId,building.id);
  assert.deepEqual(result.metadata.footprint,building.footprint);
});
