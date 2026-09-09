#!/usr/bin/env node
/** One low-priority bounded quarter build; no source fetch and no population mutation. */
import { readFile,writeFile,mkdir,rename,copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname,resolve,join,relative,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPriority,constants } from 'node:os';
import { geometryBounds } from './geo/city-geography.mjs';
import { projectLocal,localBoundsToGeographic } from './visual/geometry.mjs';
import { buildBuilding } from './visual/buildings.mjs';
import { loadLandSources } from './visual/land-source.mjs';
import { buildGreenSpace } from './visual/green-space.mjs';
import { buildTreeMeshes } from './visual/tree-crowns.mjs';
import { buildRoadSurfaces } from './visual/road-surfaces.mjs';
import { batchMeshes } from './visual/batching.mjs';
import { encodeGlb } from './visual/glb.mjs';
import { compressGlb } from './visual/compression.mjs';
import { makeTileset,meshBox } from './visual/pack.mjs';
import { prepareMaterialKit } from './visual/material-kit.mjs';
import { canonicalBuildingIds,materialLibraryFromKit,detailGridCell } from './visual/compiler-materials.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),arg=(name,fall)=>{const i=args.indexOf(`--${name}`);return i<0?fall:args[i+1];};
const materialKit=arg('material-kit',null);if(materialKit!==null&&materialKit!=='polyhaven-v1')throw new Error('Unsupported material kit; use polyhaven-v1');
const detailGrid=Number(arg('detail-grid',materialKit?'4':'2'));if(![2,4].includes(detailGrid))throw new Error('Detail grid must be 2 or 4');
const origin=String(arg('origin','61.39466,55.1654,0')).split(',').map(Number),size=Number(arg('size','1200'));
if(origin.length<2||origin.some(v=>!Number.isFinite(v))||origin[0]<61||origin[0]>62||origin[1]<54.8||origin[1]>55.6||size<200||size>1400)throw new Error('Only bounded Chelyabinsk quarter builds of 200–1400 metres are allowed');
if(origin.length===2)origin.push(0);
const sourceRoot=join(root,'apps/web/public/city-v2'),out=resolve(root,arg('out','.cache/city-visual-v1'));
if(!out.startsWith(join(root,'.cache')+sep))throw new Error('Visual build output must stay under repo .cache');
try{setPriority(0,constants.priority.PRIORITY_BELOW_NORMAL);}catch{console.log('Low-priority scheduling unavailable; single bounded compiler process retained');}
const sha=data=>createHash('sha256').update(data).digest('hex'),localBounds=[-size/2,-size/2,size/2,size/2],bounds=localBoundsToGeographic(localBounds,origin),intersects=(a,b)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
const manifestBytes=await readFile(join(sourceRoot,'manifest.json')),source=JSON.parse(manifestBytes);
const descriptors=source.cells.filter(c=>intersects(c.bbox,bounds));if(!descriptors.length||descriptors.length>36)throw new Error('Source cell envelope exceeds bounded quarter');
const buildings=new Map(),roads=new Map(),inputs=[];let decoded=0;
for(const d of descriptors){const path=resolve(sourceRoot,d.url);if(!path.startsWith(sourceRoot+sep)||d.bytes>4*1024*1024)throw new Error('Invalid source descriptor');const bytes=await readFile(path);decoded+=bytes.length;if(decoded>32*1024*1024||bytes.length!==d.bytes||sha(bytes)!==d.sha256)throw new Error('Source integrity or byte bound failed');const data=JSON.parse(bytes);inputs.push({key:d.key,sha256:d.sha256,bytes:d.bytes});for(const b of data.buildings)if(intersects(geometryBounds(b.footprint),bounds))buildings.set(b.id,b);for(const r of data.roads)if(intersects(geometryBounds({coordinates:r.coordinates}),bounds))roads.set(r.id,r);}
const allBuildings=[...buildings.values()].sort((a,b)=>a.id.localeCompare(b.id)),allRoads=[...roads.values()].sort((a,b)=>a.id.localeCompare(b.id));
if(!allBuildings.length||allBuildings.length>1500||allRoads.length>2048)throw new Error('Quarter object bound failed');
const land=await loadLandSources(root,bounds);
const green=buildGreenSpace(land.features,allBuildings,allRoads,{origin,boundsMeters:localBounds,maxTrees:1000,lod:0});
const coarseGreen={...green,meshes:[...green.meshes.filter(m=>!m.treeId),...green.treePlacements.flatMap(p=>buildTreeMeshes(p,{lod:1,baseHeight:.025}))]};
coarseGreen.diagnostics={...green.diagnostics,lod:1,vertexCount:coarseGreen.meshes.reduce((n,m)=>n+m.positions.length/3,0)};
console.log(JSON.stringify({landSourceTiles:land.source.tiles.length,landSourceBytes:land.source.bytes,greenDiagnostics:green.diagnostics}));
await mkdir(join(out,'tiles'),{recursive:true});await mkdir(join(out,'materials'),{recursive:true});
const textures={},textureAssets=[];for(const [name,key] of [['atlas','atlasUri'],['normal','normalUri'],['orm','ormUri']]){const input=arg(name,null);if(!input)continue;const data=await readFile(resolve(root,input));if(data.length>16*1024*1024||data.readUInt32BE(0)!==0x89504e47)throw new Error('Only bounded PNG textures accepted');const file=`${name}-${sha(data).slice(0,16)}.png`;await copyFile(resolve(root,input),join(out,'materials',file));textures[key]=`../materials/${file}`;textureAssets.push({uri:`materials/${file}`,sha256:sha(data),bytes:data.length,width:data.readUInt32BE(16),height:data.readUInt32BE(20),role:name});}
const kit=materialKit?await prepareMaterialKit(out):null;
const materialLibrary=kit?materialLibraryFromKit(kit,sha(await readFile(join(root,'tools/visual/assets/polyhaven-materials-v1.json')))):null;
const assets=[],semantic={},stats={sourceCells:inputs.length,sourceBytes:decoded,landSourceTiles:land.source.tiles.length,landSourceBytes:land.source.bytes,buildings:allBuildings.length,roads:allRoads.length,tiles:0,vertices:0,triangles:0,drawGroups:0,windowCount:0,trees:green.treePlacements.length};
async function writeAsset(name,bytes,canonicalIds){const hash=sha(bytes),path=`${name}-${hash.slice(0,16)}.glb`;await writeFile(join(out,path),bytes);const value={uri:path,sha256:hash,bytes:bytes.length,canonicalIds};assets.push(value);return value;}
async function compileTile(name,items,clip,lod,quadrant=null){
  const parts=[];for(const b of items){const result=buildBuilding(b,{origin,lod});parts.push(...result.meshes);if(!lod){semantic[b.id]=result.metadata;stats.windowCount+=result.metadata.windowCount;}}
  const road=buildRoadSurfaces(allRoads,{origin,boundsMeters:clip,lod});parts.push(...road.meshes);
  const ground=lod?coarseGreen:buildGreenSpace(land.features,allBuildings,allRoads,{origin,boundsMeters:clip,maxTrees:0,maxDecorations:0,lod:0});
  parts.push(...ground.meshes);if(!lod){const owns=p=>detailGridCell(p.point,size,detailGrid).every((v,i)=>v===quadrant[i]);const ids=new Set(green.treePlacements.filter(owns).map(p=>p.id)),decorationIds=new Set(green.decorationPlacements.filter(owns).map(p=>p.id));parts.push(...green.meshes.filter(m=>m.treeId&&ids.has(m.treeId)||m.decorationId&&decorationIds.has(m.decorationId)));}
  const batches=batchMeshes(parts),vertices=batches.reduce((n,m)=>n+m.positions.length/3,0);if(vertices>2_000_000)throw new Error('Per-tile vertex bound exceeded');
  const bytes=await compressGlb(encodeGlb(batches,{origin,lod,...textures,...(kit?{materialTextures:kit.materialTextures}:{})}));if(bytes.length>96*1024*1024)throw new Error('Per-tile GLB byte bound exceeded');const asset=await writeAsset(name,bytes,canonicalBuildingIds(batches));stats.tiles++;stats.vertices+=vertices;stats.triangles+=batches.reduce((n,m)=>n+m.indices.length/3,0);stats.drawGroups+=batches.length;console.log(JSON.stringify({tile:name,buildings:items.length,vertices,bytes:bytes.length,drawGroups:batches.length,roadDiagnostics:road.diagnostics,greenDiagnostics:ground.diagnostics}));return {...asset,box:meshBox(batches),buildings:items.length,roadDiagnostics:road.diagnostics,greenDiagnostics:ground.diagnostics};
}
const coarse=await compileTile('tiles/coarse',allBuildings,localBounds,1),children=[];
for(let y=0;y<detailGrid;y++)for(let x=0;x<detailGrid;x++){const half=size/2,step=size/detailGrid,clip=[-half+x*step,-half+y*step,-half+(x+1)*step,-half+(y+1)*step];const items=allBuildings.filter(b=>{const [bx,by]=detailGridCell(projectLocal(b.center,origin),size,detailGrid);return bx===x&&by===y;});children.push(await compileTile(`tiles/near-${x}-${y}`,items,clip,0,[x,y]));}
const tileset=makeTileset({origin,bounds,coarse,children}),semanticBytes=Buffer.from(JSON.stringify({contract:'CityVisualSemanticsV1',origin,sourceDatasetVersion:source.datasetVersion,buildings:semantic,vegetation:{sourceDatasetVersion:land.source.datasetVersion,treePlacements:green.treePlacements,representation:'source_land_geometry_with_illustrative_vegetation'},courtyardDecorations:{placements:green.decorationPlacements,representation:'visual_synthesis_inside_source_courtyard_holes_or_park_garden_polygons'}}));
await writeFile(join(out,'semantics.json'),semanticBytes);
const tilesetBytes=Buffer.from(JSON.stringify(tileset,null,2)+'\n');await writeFile(join(out,'tileset.json.tmp'),tilesetBytes);await rename(join(out,'tileset.json.tmp'),join(out,'tileset.json'));
const compilerFiles=['tools/build-city-visual-pack.mjs','tools/visual/geometry.mjs','tools/visual/buildings.mjs','tools/visual/building-details.mjs','tools/visual/glb.mjs','tools/visual/compression.mjs','tools/visual/materials.mjs','tools/visual/material-kit.mjs','tools/visual/assets/polyhaven-materials-v1.json','tools/visual/compiler-materials.mjs','tools/visual/land-source.mjs','tools/visual/green-space.mjs','tools/visual/courtyard-details.mjs','tools/visual/tree-crowns.mjs','tools/visual/vegetation-tiles.mjs','tools/visual/batching.mjs','tools/visual/pack.mjs','tools/visual/road-surfaces.mjs'];
const report={contract:'CityVisualPackManifestV1',version:1,origin,bounds,coordinateSystem:'east-up-south',tileFrame:'east-north-up_to_ecef',coverage:'bounded_quarter',source:{packId:source.packId,datasetVersion:source.datasetVersion,manifestSha256:sha(manifestBytes),cells:inputs},art:{familyCount:8,atlasLayout:'4x4-panel-brick-plaster-glass-industrial-civic-timber-neutral-bitumen-metal-tile-concrete-asphalt-paving-grass-trim',textures,representation:'visual_synthesis',geometry:'original rings/holes, source-edge facades, illustrated trims/windows/roofs',vegetation:'sparse illustrative only inside verified source courtyard holes'},populationCompatibility:{datasetId:'omnitwin-fictional-city-v2',sourceDatasetVersion:source.datasetVersion,canonicalIds:[...buildings.keys()].sort(),reassignments:0,populationMutated:false},semantics:{uri:'semantics.json',bytes:semanticBytes.length,sha256:sha(semanticBytes)},tileset:{uri:'tileset.json',bytes:tilesetBytes.length,sha256:sha(tilesetBytes)},assets,stats,compilerSourceHashes:Object.fromEntries(await Promise.all(compilerFiles.map(async p=>[p,sha(await readFile(join(root,p)))]))),limitations:['Compiled city-v2 source omitted building parts and detailed roof/base tags; this pack cannot recover them.','Unknown architecture, road widths, window placement and courtyard vegetation are visual synthesis, not surveyed reality.','Unmeasured bridges and tunnels are omitted rather than drawn at invented elevations.','This is a bounded quarter proof, not all-city coverage or performance evidence.'],license:{sourceGeometry:'ODbL-1.0',attribution:'© OpenStreetMap contributors',sourceLedger:source.sourceLedger}};
report.landSource=land.source;report.vegetation=green.diagnostics;report.art.vegetation='source green polygons; illustrative trees only in wood/forest/park/garden or at explicit source tree points; one global 1000-tree cap';
report.art.detailGrid=detailGrid;
report.art.groundAlbedoFallback='solid_muted_green_with_analytic_vertex_variation_until_metric_tiling';
if(materialLibrary){report.materialLibrary=materialLibrary;report.art.atlasLayout=textureAssets.length?report.art.atlasLayout:null;report.art.texturing='metric_repeat_PBR_with_source_owned_facade_details';report.art.textureScaleRepresentation='visual_synthesis';}
report.acceptance={stage:'quarter_prototype',citywideAccepted:false,visualReview:'pending_owner_review_of_pass_3',performanceValidated:false};
report.textureAssets=textureAssets;report.compression={extension:'EXT_meshopt_compression',lossless:true,faceOrderPreserved:true};report.lightingMaterials={normalMap:Boolean(kit||textures.normalUri),occlusionTexture:Boolean(kit||textures.ormUri),occlusionFallback:'explicit analytical vertex base/contact tint; not a baked ray-traced AO map',roughness:kit?'CC0 per-texel roughness with explicit material factors':'per-family material values',directionalLightingBaked:false};report.tileDiagnostics=[coarse,...children].map(({uri,buildings,roadDiagnostics,greenDiagnostics})=>({uri,buildings,roadDiagnostics,greenDiagnostics}));
await writeFile(join(out,'manifest.json.tmp'),JSON.stringify(report,null,2)+'\n');await rename(join(out,'manifest.json.tmp'),join(out,'manifest.json'));console.log(JSON.stringify({output:relative(root,out),stats,tileset:'tileset.json',textured:Boolean(kit||textures.atlasUri),materialKit}));
