import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuilding, classifyFamily } from './buildings.mjs';
import { projectLocal, tangentFrame } from './geometry.mjs';

const origin=[61.39466,55.1654,0];
const ring=[[61.394,55.165],[61.395,55.165],[61.395,55.166],[61.394,55.166],[61.394,55.165]];
const hole=[[61.3943,55.1653],[61.3943,55.1657],[61.3947,55.1657],[61.3947,55.1653],[61.3943,55.1653]];
const building={id:'openmaptiles_buildings:1230',osmId:'way/123',sourceClass:'apartments',heightM:27,levels:9,heightQuality:'derived_floors',sourceAttributes:{building:'apartments'},footprint:{type:'Polygon',coordinates:[ring,hole]}};
test('source rings and courtyard survive; geometry and all details retain canonical owner',()=>{
  const input=JSON.stringify(building), result=buildBuilding(building,{origin,lod:0});
  assert.equal(JSON.stringify(building),input);
  assert.deepEqual(result.metadata.footprint,building.footprint);
  assert.equal(result.metadata.ringCount,2);
  assert.ok(result.meshes.some(m=>m.name.endsWith(':windows')));
  assert.ok(result.meshes.some(m=>m.name.endsWith(':trim')));
  for(const mesh of result.meshes){assert.equal(mesh.canonicalId,building.id);assert.equal(mesh.positions.length,mesh.normals.length);assert.equal(mesh.uvs.length*3,mesh.positions.length*2);assert.ok(mesh.positions.every(Number.isFinite));}
  const roof=result.meshes.find(m=>m.name.endsWith(':roof'));
  const center=projectLocal([61.3945,55.1655],origin);
  for(let i=0;i<roof.indices.length;i+=3){const tri=roof.indices.slice(i,i+3).map(j=>[roof.positions[j*3],-roof.positions[j*3+2]]);assert.equal(contains(center,tri),false,'no triangle fills the real courtyard');}
});
function contains(p,t){const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);const v=t.map((a,i)=>cross(a,t[(i+1)%3],p));return v.every(n=>n>1e-7)||v.every(n=>n< -1e-7);}
test('determinism, eight-family material grammar, and bounded detail LOD',()=>{
  assert.deepEqual(buildBuilding(building,{origin,lod:0}),buildBuilding(building,{origin,lod:0}));
  const families=['apartments','brick','plaster','office','industrial','school','house','yes'].map(sourceClass=>classifyFamily({...building,sourceClass,sourceAttributes:{building:sourceClass},heightM:sourceClass==='apartments'?27:sourceClass==='office'?36:6}));
  assert.equal(new Set(families).size,8);
  const coarse=buildBuilding(building,{origin,lod:1});assert.ok(!coarse.meshes.some(m=>m.name.endsWith(':windows')));assert.equal(coarse.metadata.canonicalId,building.id);
});
test('WGS84 tangent frame is orthonormal, metre-scaled, and finite',()=>{
  const frame=tangentFrame(origin);assert.equal(frame.length,16);const p=projectLocal([origin[0]+.01,origin[1]],origin);assert.ok(p[0]>635&&p[0]<640);assert.equal(p[1],0);
  for(const off of [0,4,8])assert.ok(Math.abs(Math.hypot(...frame.slice(off,off+3))-1)<1e-12);
});
test('residential window glass stays1.2–1.4m wide and is not a floor-to-ceiling curtain wall',()=>{
  const result=buildBuilding(building,{origin,lod:0}),windows=result.meshes.find(m=>m.name.endsWith(':windows'));
  for(let i=0;i<windows.positions.length;i+=18){const a=windows.positions.slice(i,i+3),b=windows.positions.slice(i+3,i+6),c=windows.positions.slice(i+6,i+9);const width=Math.hypot(b[0]-a[0],b[2]-a[2]);assert.ok(width>=1.19&&width<=1.41);assert.ok(c[1]-a[1]<=1.51);}
  assert.notEqual(classifyFamily({...building,sourceClass:'commercial',sourceAttributes:{building:'commercial'},heightM:12}),'glass');
});
test('illustrative appearance varies deterministically while source family and footprint stay fixed',()=>{
  const variants=Array.from({length:12},(_,i)=>buildBuilding({...building,id:`appearance-${i}`},{origin,lod:0}));
  assert.ok(new Set(variants.map(v=>JSON.stringify(v.metadata.appearance?.facadeTint))).size>=3);
  for(const result of variants){
    assert.equal(result.metadata.family,'panel');
    assert.equal(result.metadata.appearance.representation,'visual_synthesis');
    assert.deepEqual(result.metadata.footprint,building.footprint);
  }
  const near=buildBuilding(building,{origin,lod:0}),coarse=buildBuilding(building,{origin,lod:1});
  assert.deepEqual(near.metadata.appearance.facadeTint,coarse.metadata.appearance.facadeTint);
});
test('flat-roof fixtures avoid source courtyard holes and retain canonical ownership',()=>{
  const result=buildBuilding(building,{origin,lod:0});
  const fixtures=result.metadata.appearance?.roofFixtures;
  assert.ok(fixtures?.length>0&&fixtures.length<=24);
  const outer=ring.slice(0,-1).map(p=>projectLocal(p,origin)),inner=hole.slice(0,-1).map(p=>projectLocal(p,origin));
  const minX=Math.min(...outer.map(p=>p[0])),maxX=Math.max(...outer.map(p=>p[0])),minY=Math.min(...outer.map(p=>p[1])),maxY=Math.max(...outer.map(p=>p[1]));
  const holeX=[Math.min(...inner.map(p=>p[0])),Math.max(...inner.map(p=>p[0]))],holeY=[Math.min(...inner.map(p=>p[1])),Math.max(...inner.map(p=>p[1]))];
  for(const f of fixtures)for(const [x,y] of f.corners){
    assert.ok(x>minX+1&&x<maxX-1&&y>minY+1&&y<maxY-1);
    assert.ok(x<holeX[0]||x>holeX[1]||y<holeY[0]||y>holeY[1]);
  }
  assert.ok(result.meshes.some(m=>m.name.endsWith(':roofFixtures')&&m.canonicalId===building.id));
  assert.equal(buildBuilding({...building,sourceAttributes:{building:'house','roof:shape':'gabled'}},{origin,lod:0}).metadata.appearance.roofFixtures.length,0);
});
test('close facade grammar has recessed glass, entrances, plinth and bounded balconies',()=>{
  const near=buildBuilding(building,{origin,lod:0}),far=buildBuilding(building,{origin,lod:1});
  const grammar=near.metadata.appearance.facadeGrammar;
  assert.equal(grammar.representation,'visual_synthesis');
  assert.equal(grammar.family,'panel');
  assert.ok(grammar.entranceCount>0&&grammar.entranceCount<=4);
  assert.ok(grammar.balconyCount>0&&grammar.balconyCount<=80);
  assert.ok(near.meshes.some(m=>m.name.endsWith(':plinth')));
  assert.ok(near.meshes.some(m=>m.name.endsWith(':entrances')));
  assert.ok(near.meshes.some(m=>m.name.endsWith(':windowReveals')));
  assert.ok(near.meshes.some(m=>m.name.endsWith(':balconies')));
  assert.equal(far.metadata.appearance.facadeGrammar.entranceCount,0);
  for(const m of near.meshes)assert.equal(m.canonicalId,building.id);
  const glass=near.meshes.find(m=>m.name.endsWith(':windows'));
  const frame=near.meshes.find(m=>m.name.endsWith(':windowReveals'));
  assert.ok(frame.positions.length>0&&glass.positions.length>0);
  assert.deepEqual(near.metadata.footprint,far.metadata.footprint);
  assert.equal(near.metadata.sourceHeightM,building.heightM);
});
test('far LOD keeps real floor spacing with cheap bounded window cards and a single wall per edge',()=>{
  const near=buildBuilding(building,{origin,lod:0}),far=buildBuilding(building,{origin,lod:1});
  const windows=far.meshes.find(m=>m.name.endsWith(':windowsFar'));
  assert.ok(windows,'far buildings need readable windows rather than blank concrete blocks');
  assert.ok(far.metadata.windowCount>0&&far.metadata.windowCount<=512);
  const rows=new Set();for(let i=0;i<windows.positions.length;i+=18)rows.add(windows.positions[i+1].toFixed(3));
  assert.equal(rows.size,building.levels,'far LOD preserves nine floors instead of stretching one window row over the entire height');
  assert.equal(windows.positions.length/3,far.metadata.windowCount*6);
  const shell=far.meshes.find(m=>m.name.endsWith(':shell'));
  assert.equal(shell.positions.length/3,far.metadata.edgeCount*6);
  assert.ok(!far.meshes.some(m=>m.name.endsWith(':windowReveals')||m.name.endsWith(':balconies')));
  assert.ok(far.meshes.reduce((sum,m)=>sum+m.positions.length,0)<near.meshes.reduce((sum,m)=>sum+m.positions.length,0)*.15);
});
