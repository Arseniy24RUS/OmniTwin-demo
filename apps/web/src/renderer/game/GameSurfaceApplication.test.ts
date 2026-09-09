import {describe,expect,it} from 'vitest';
import {MercatorCoordinate} from 'maplibre-gl';
import {Vector3,type Object3D,type Mesh,type InstancedMesh} from 'three';
import {localToMercatorMatrix} from './cameraAdapter';
import type {VerifiedCityBuildingSnapshot} from '../verifiedCityBuildingTypes';
import {GameRoadSurfaces,prepareGameRoadSurfaces} from './GameRoadSurfaces';
import {GameLandCover,prepareGameLandCover} from './GameLandCover';
import {GameLandUseGround,prepareGameLandUseGround} from './GameLandUseGround';
import {GameVegetation,prepareGameVegetation,type GameVegetationFeature} from './GameVegetation';
import {GameCourtyardGround,prepareGameCourtyardGround} from './GameCourtyardGround';
import {GameBuildingContacts,prepareGameBuildingContacts} from './GameBuildingContacts';

const origin={longitude:61.39466,latitude:55.1654},matrix=localToMercatorMatrix(origin);
const geo=(x:number,z:number):[number,number]=>{const p=new Vector3(x,0,z).applyMatrix4(matrix),ll=new MercatorCoordinate(p.x,p.y).toLngLat();return[ll.lng,ll.lat];};
const ring=(x:number,z:number,size:number)=>[[x,z],[x+size,z],[x+size,z+size],[x,z+size],[x,z]].map(p=>geo(p[0]!,p[1]!));
const nw=geo(-100,-100),se=geo(300,300),bounds=[nw[0],se[1],se[0],nw[1]] as const;
const buildings:VerifiedCityBuildingSnapshot={datasetVersion:'source-test',signature:'source-a',canonicalIds:new Set(['owner']),
  data:{type:'FeatureCollection',features:[{type:'Feature',id:'owner',properties:{canonical_id:'owner'},geometry:{type:'Polygon',coordinates:[ring(0,0,100),ring(10,10,80)]}}]},
  cells:['cell'],coverage:'complete_viewport',coverageBounds:bounds,invalidBuildings:0,omittedBuildings:0,vertexCount:10};
const roads=[{id:'road',coordinates:[geo(-80,-20),geo(200,-20)],className:'residential',lanes:2}];
const options={origin,bounds,buildings,roads,qualityTier:'medium' as const,sourceId:'source-test',datasetVersion:'source-test',waterFeatures:[]};
const park:GameVegetationFeature={id:'park',sourceLayer:'landuse',properties:{class:'park'},geometry:{type:'Polygon',coordinates:[ring(120,120,100)]}};
const residential:GameVegetationFeature={...park,id:'residential',properties:{class:'residential'}};
function geometry(root:Object3D){
  const result:unknown[]=[];root.traverse(object=>{const mesh=object as Mesh;if(!mesh.isMesh)return;
    const attributes=Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([key,value])=>[key,Array.from(value.array)]));
    const instanced=mesh as unknown as InstancedMesh;
    result.push({name:mesh.name,attributes,index:mesh.geometry.index?Array.from(mesh.geometry.index.array):null,
      instances:instanced.isInstancedMesh?{count:instanced.count,matrix:Array.from(instanced.instanceMatrix.array),color:instanced.instanceColor?Array.from(instanced.instanceColor.array):null}:null});
  });return result;
}
describe('worker-prepared surface application',()=>{
  it('applies cloned exact geometry for all six surfaces and retains it after worker failure',()=>{
    const cases=[
      {a:new GameRoadSurfaces(),b:new GameRoadSurfaces(),run:(x:GameRoadSurfaces)=>x.update(roads,options),apply:(x:GameRoadSurfaces)=>x.applyPrepared(structuredClone(prepareGameRoadSurfaces(roads,options)),options)},
      {a:new GameLandCover(),b:new GameLandCover(),run:(x:GameLandCover)=>x.update([park],options),apply:(x:GameLandCover)=>x.applyPrepared(structuredClone(prepareGameLandCover([park],options)),options)},
      {a:new GameLandUseGround(),b:new GameLandUseGround(),run:(x:GameLandUseGround)=>x.update([residential],options),apply:(x:GameLandUseGround)=>x.applyPrepared(structuredClone(prepareGameLandUseGround([residential],options)),options)},
      {a:new GameVegetation(),b:new GameVegetation(),run:(x:GameVegetation)=>x.update([park],options),apply:(x:GameVegetation)=>x.applyPrepared(structuredClone(prepareGameVegetation([park],options)),options)},
      {a:new GameCourtyardGround(),b:new GameCourtyardGround(),run:(x:GameCourtyardGround)=>x.update(options),apply:(x:GameCourtyardGround)=>x.applyPrepared(structuredClone(prepareGameCourtyardGround(options)),options)},
      {a:new GameBuildingContacts(),b:new GameBuildingContacts(),run:(x:GameBuildingContacts)=>x.update(options),apply:(x:GameBuildingContacts)=>x.applyPrepared(structuredClone(prepareGameBuildingContacts(options)),options)},
    ];
    for(const entry of cases){
      // Each tuple supplies its matching class. The heterogeneous loop shares
      // only the committed geometry/retention contract being tested here.
      entry.run(entry.a as never);entry.apply(entry.b as never);
      expect(entry.b.telemetry.state).toBe('ready');expect(geometry(entry.b.object)).toEqual(geometry(entry.a.object));
      expect(geometry(entry.b.object).length).toBeGreaterThan(0);
      const retained=[...entry.b.object.children],before=geometry(entry.b.object);
      entry.b.retainFailure('Worker unavailable',origin);
      expect(entry.b.telemetry.state).toBe('error_retained');expect(entry.b.object.children).toEqual(retained);expect(geometry(entry.b.object)).toEqual(before);
      entry.a.dispose();entry.b.dispose();entry.b.retainFailure('Late result',origin);expect(entry.b.telemetry.state).toBe('disposed');
    }
  });
});
