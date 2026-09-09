import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLandTiles,extractLandFeatures } from './land-source.mjs';
test('only intersecting maximum-detail source tiles are selected',()=>{
 const m={tiles:[{z:14,x:10986,y:5169},{z:13,x:5493,y:2584},{z:14,x:2,y:2}]};
 assert.equal(selectLandTiles(m,[61.394,55.165,61.395,55.166]).length,1);assert.equal(selectLandTiles(m,[0,0,.01,.01]).length,0);
});
test('tree labels are not tree points; source geometry, stable tile IDs and shape are preserved',()=>{
 const feature=(type,properties,geometry,id=7)=>({type,properties,id,toGeoJSON:()=>({type:'Feature',geometry,properties})});
 const records={landcover:[feature(3,{class:'grass',subclass:'park'},{type:'Polygon',coordinates:[[[61,55],[62,55],[61,56],[61,55]]]})],poi:[feature(1,{class:'tree'},{type:'Point',coordinates:[61.4,55.1]}),feature(1,{class:'restaurant',name:'Tree'},{type:'Point',coordinates:[61.4,55.1]})]};
 const tile={layers:Object.fromEntries(Object.entries(records).map(([k,v])=>[k,{length:v.length,feature:i=>v[i]}]))};
 const found=extractLandFeatures(tile,{z:14,x:1,y:2},'version');assert.equal(found.length,2);assert.equal(found[0].sourceLayer,'landcover');assert.match(found[0].id,/version/);assert.deepEqual(found[0].geometry,records.landcover[0].toGeoJSON().geometry);
});
