import {describe,it,expect} from 'vitest';
import {Box3,Vector3} from 'three';
import {TilesRenderer} from '3d-tiles-renderer/three';
import {createGameBuildingLodPolicy,gameLodResolution,GAME_BUILDING_LOD_CATALOG,GAME_BUILDING_DETAIL_ERROR_METERS} from './gameBuildingLod';
import {buildBuilding} from '../../../../../tools/visual/buildings.mjs';

function coarse(){return {geometricError:32,refine:'REPLACE',content:{uri:'tiles/coarse-0123456789abcdef.glb'},extras:{units:'metres',coordinateSystem:'east-up-south',coverage:'bounded_quarter'},children:[{geometricError:0,content:{uri:'tiles/near-0-0123456789abcdef.glb'}}]};}
describe('metric visual building LOD',()=>{
 it('uses a bounded 2m omission for the audited catalog without changing children or geometry identity',()=>{
  const policy=createGameBuildingLodPolicy(GAME_BUILDING_LOD_CATALOG)!;const tile={...coarse(),boundingVolume:{box:[0,0,0,100,0,0,0,100,0,0,0,20]}},before=structuredClone(tile);
  const renderer=new TilesRenderer() as any;renderer.registerPlugin(policy);renderer.preprocessNode(tile,'https://assets.example/cell');
  expect(tile.geometricError).toBe(2);expect(tile.content).toEqual(before.content);expect(tile.children).toEqual(before.children);
  expect(policy.diagnostics.adjustedCoarseTiles).toBe(1);policy.preprocessNode(tile);expect(policy.diagnostics.adjustedCoarseTiles).toBe(1);
  expect(createGameBuildingLodPolicy('unknown')).toBeNull();renderer.dispose();
 });
 it('leaves other roots, unknown grammars and metadata wrappers at their declared errors',()=>{
  const policy=createGameBuildingLodPolicy(GAME_BUILDING_LOD_CATALOG)!;
  for(const tile of [{...coarse(),geometricError:128},{...coarse(),extras:{units:'feet'}},{...coarse(),content:{uri:'cell.json'}},{...coarse(),children:[{geometricError:10}]}]){const before=structuredClone(tile);policy.preprocessNode(tile);expect(tile).toEqual(before);}
 });
 it('measures geometry detail in CSS pixels regardless of framebuffer density',()=>{
  expect(gameLodResolution({width:2560,height:1600,clientWidth:1280,clientHeight:800})).toEqual({width:1280,height:800});
  expect(gameLodResolution({width:1280,height:800,clientWidth:1280,clientHeight:800})).toEqual({width:1280,height:800});
  expect(gameLodResolution({width:2,height:2,clientWidth:0,clientHeight:0})).toEqual({width:1,height:1});
 });
 it('the installed renderer keeps the user z15.703 at coarse and asks for yard detail near z17–20',()=>{
  const tiles=new TilesRenderer() as any,policy=createGameBuildingLodPolicy(GAME_BUILDING_LOD_CATALOG)!,tile:any=coarse();policy.preprocessNode(tile);
  const height=800,fov=2*Math.atan(1/3),pitch=55.5*Math.PI/180,lat=55.163784*Math.PI/180;
  const projectionDenominator=2*Math.tan(fov/2)/height;
  const errorAt=(zoom:number)=>{const metresPerCssPixel=40075016.68557849*Math.cos(lat)/(512*2**zoom),distance=Math.max(1,1.5*height*metresPerCssPixel*Math.cos(pitch)-40);
   tile.engineData={boundingVolume:{distanceToPoint:()=>distance,intersectsFrustum:()=>true}};
   tiles.cameras=[{}];tiles.cameraInfo=[{isOrthographic:false,sseDenominator:projectionDenominator,position:new Vector3(),frustum:{}}];
   const result:any={};tiles.calculateTileViewError(tile,result);return result.error;};
  expect(errorAt(15.703)).toBeLessThan(8);expect(errorAt(15.703)*16).toBeGreaterThan(8);
  const ascending=Array.from({length:25},(_,i)=>14+i*.25).map(zoom=>[zoom,errorAt(zoom)]);
  expect(ascending.every(([,error])=>Number.isFinite(error))).toBe(true);
  expect(ascending.filter(([zoom])=>zoom<=16).every(([,error])=>error<8)).toBe(true);
  expect(ascending.filter(([zoom])=>zoom>=17).every(([,error])=>error>8)).toBe(true);
  expect([...ascending].reverse().map(([zoom])=>errorAt(zoom))).toEqual(ascending.map(([,error])=>error).reverse());
  tiles.dispose();
 });
 it('current authored omissions remain within the bound and both LODs keep source roofs/IDs',()=>{
  const origin=[61.39466,55.1654,0],coordinates=[[[61.394,55.165],[61.396,55.165],[61.396,55.166],[61.394,55.166],[61.394,55.165]]];
  for(const family of ['apartments','brick','plaster','office','industrial','school','house','yes']){
   const building={id:'openmaptiles_buildings:1230',sourceClass:family,sourceAttributes:{building:family,'roof:shape':'flat'},heightM:36,levels:12,footprint:{type:'Polygon',coordinates}};
   const far=buildBuilding(building,{origin,lod:1}),near=buildBuilding(building,{origin,lod:0});
   expect(near.metadata.canonicalId).toBe(far.metadata.canonicalId);expect(near.metadata.footprint).toEqual(far.metadata.footprint);
   // Coarse roofs add six-triangle parapets to this mesh; detailed parapets
   // belong to the trim mesh. Compare the actual source-height cap, not that
   // intentionally different decoration inventory.
   const roofCap=(result:any)=>{const roof=result.meshes.find((m:any)=>m.name.endsWith(':roof')),cap:number[]=[];
    for(let i=0;i<roof.indices.length;i+=3){const vertices=roof.indices.slice(i,i+3).map((index:number)=>roof.positions.slice(index*3,index*3+3));
     if(vertices.every((point:number[])=>point[1]===building.heightM))cap.push(...vertices.flat());}
    expect(cap.length).toBeGreaterThan(0);return cap;};
   expect(near.metadata.sourceHeightM).toBe(building.heightM);expect(far.metadata.sourceHeightM).toBe(building.heightM);
   expect(roofCap(near)).toEqual(roofCap(far));
   const box=new Box3();for(const mesh of far.meshes.filter((m:any)=>m.name.endsWith(':shell')))for(let i=0;i<mesh.positions.length;i+=3)box.expandByPoint(new Vector3(...mesh.positions.slice(i,i+3)));
   let maximum=0;const p=new Vector3();
   for(const mesh of near.meshes)for(let i=0;i<mesh.positions.length;i+=3){p.set(mesh.positions[i],mesh.positions[i+1],mesh.positions[i+2]);let distance=box.distanceToPoint(p);
    if(box.containsPoint(p))distance=Math.min(p.x-box.min.x,box.max.x-p.x,p.y-box.min.y,box.max.y-p.y,p.z-box.min.z,box.max.z-p.z);
    maximum=Math.max(maximum,distance);
   }
   expect(maximum).toBeLessThanOrEqual(GAME_BUILDING_DETAIL_ERROR_METERS);
  }
 });
});
