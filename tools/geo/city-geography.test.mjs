import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleRelation, pointInGeometry, normalizeBuilding, normalizeRoad, cellsForBounds, indexBuildings } from './city-geography.mjs';

const square = { type: 'Polygon', coordinates: [[[61,55],[61.001,55],[61.001,55.001],[61,55.001],[61,55]]] };
test('boundary stitch preserves disconnected outers and holes; open relation fails closed', () => {
  const member = (ref, role, p) => ({ type:'way', ref, role, geometry:p.map(([lon,lat])=>({lon,lat})) });
  const relation = { members:[member(1,'outer',[[0,0],[2,0],[2,2]]),member(2,'outer',[[0,0],[0,2],[2,2]]),member(3,'inner',[[.5,.5],[1,.5],[1,1],[.5,1],[.5,.5]])] };
  const geometry = assembleRelation(relation);
  assert.equal(pointInGeometry([.25,.25],geometry),true);
  assert.equal(pointInGeometry([.75,.75],geometry),false);
  assert.throws(()=>assembleRelation({members:[member(4,'outer',[[0,0],[1,0],[1,1]])]}), /Unclosed/);
});
test('building physical footprint, exact tags and provider canonical IDs never imply mixed', () => {
  const element = { type:'way', id:59178065, tags:{building:'school','building:levels':'4'}, geometry:square.coordinates[0].map(([lon,lat])=>({lon,lat})) };
  const b=normalizeBuilding(element,'RU-CHE-SET-CEN');
  assert.equal(b.id,'openmaptiles_buildings:591780650');
  assert.equal(b.use,'study'); assert.equal(b.heightM,12); assert.equal(b.levels,4);
  assert.ok(b.areaM2>6000 && b.areaM2<8000);
  assert.equal(normalizeBuilding({...element,tags:{building:'yes'}},'x').use,'unknown');
  assert.equal(normalizeBuilding({...element,tags:{building:'yes'}},'x').capacityWeight,0);
  assert.equal(normalizeBuilding({...element,geometry:[]},'x'),null);
});
test('index deduplicates source IDs independently of cell order and retains largest footprint', () => {
  const base = {id:'openmaptiles_buildings:10',center:[61,55],districtId:'x',use:'residential',areaM2:100,levels:3,heightM:9,capacityWeight:10,classificationProvenance:'source_attribute'};
  assert.deepEqual(indexBuildings([base,{...base,areaM2:80}]),indexBuildings([{...base,areaM2:80},base]));
  assert.equal(indexBuildings([base,base]).rows.length,1);
});
test('cell coverage includes both sides of seam, roads retain topology and reverse oneway',()=>{
  const cells=cellsForBounds([61.402,55.16,61.414,55.167],16);
  assert.ok(cells.length>=4); assert.equal(new Set(cells.map(c=>c.key)).size,cells.length);
  const road=normalizeRoad({id:5,nodes:[1,2],tags:{highway:'residential',oneway:'-1',lanes:'2',maxspeed:'40'},geometry:[{lon:61,lat:55},{lon:61.001,lat:55}]});
  assert.equal(road.startNodeId,'osm-node:2'); assert.equal(road.endNodeId,'osm-node:1');
  assert.equal(road.oneway,true); assert.equal(road.drivable,true); assert.equal(road.maxspeed,40);
});
