import test from 'node:test';
import assert from 'node:assert/strict';
import {selectTreeMeshes,treeQuadrant} from './vegetation-tiles.mjs';
test('retained global tree IDs partition once including quadrant boundary points',()=>{
 const treePlacements=[[-1,-1],[0,-1],[-1,0],[0,0]].map((point,i)=>({id:`tree-${i}`,point}));
 const meshes=[{name:'ground'},...treePlacements.flatMap(p=>[{treeId:p.id,material:'trunk'},{treeId:p.id,material:'leaves'}])],green={treePlacements,meshes};
 const selected=[];for(let y=0;y<2;y++)for(let x=0;x<2;x++){const m=selectTreeMeshes(green,x,y);assert.equal(m.length,2);selected.push(...m);}
 assert.equal(new Set(selected).size,8);assert.deepEqual(treeQuadrant([0,0]),[1,1]);assert.equal(meshes.length,9);
});
