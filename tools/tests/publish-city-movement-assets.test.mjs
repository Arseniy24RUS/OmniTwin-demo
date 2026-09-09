import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {encodePersonShard} from '../../shared/demo-population/index.mjs';
import {SPATIAL_NONE} from '../../shared/demo-population/spatial.mjs';
import {encodeMovementPage} from '../../shared/demo-population/movement-index.mjs';
import {planCityMovementAssets,publishCityMovementAssets,summarizeCityMovementPlan} from '../publish-city-movement-assets.mjs';
import {PROJECT_NUMBER} from '../publish-firebase-city-assets.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),json=x=>Buffer.from(JSON.stringify(x));
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'omnitwin-movement-release-'));t.after(()=>rm(root,{recursive:true,force:true}));const publicRoot=join(root,'public'),overlayRoot=join(root,'overlay');
  const put=async(base,path,bytes)=>{await mkdir(dirname(join(base,path)),{recursive:true});await writeFile(join(base,path),bytes);return {url:path,bytes:bytes.length,sha256:sha(bytes)};};
  const codeHashes={};for(const[key,path]of Object.entries({populationCodec:'index.mjs',spatialCodec:'spatial.mjs',codec:'movement-index.mjs',movementRoadPolicy:'movement-road-policy.mjs'}))codeHashes[key]=sha(await readFile(new URL(`../../shared/demo-population/${path}`,import.meta.url)));
  const geography=await put(publicRoot,'city-v2/manifest.json',json({contract:'DemoCityPackManifestV2',buildingIndex:{sha256:'a'.repeat(64)}}));
  const population=await put(publicRoot,'demo-v2/manifest.json',json({contract:'DemoPopulationManifestV2',datasetId:'omnitwin-fictional-city-v2',recordCount:1,householdCount:1,scientificClaim:false,predictiveValidation:false,spatial:{geographyManifestSha256:geography.sha256}}));
  const spatial=await put(publicRoot,'demo-v2/spatial/manifest.json',json({contract:'DemoSpatialManifestV2',datasetId:'omnitwin-fictional-city-v2',recordCount:1,householdCount:1,buildingCount:1,sourceHashes:{populationManifest:population.sha256,geographyManifest:geography.sha256,buildingIndex:'a'.repeat(64),...codeHashes}}));
  const baseHashes={population:population.sha256,spatial:spatial.sha256,geography:geography.sha256},key='16/43944/20676';
  const asset=async(stem,bytes)=>{const descriptor=await put(overlayRoot,`${stem}-${sha(bytes).slice(0,16)}.json`,bytes);descriptor.gzip=await put(overlayRoot,descriptor.url+'.gz',gzipSync(bytes));return descriptor;};
  const bindings=await asset('bindings',json({contract:'DemoMovementCellContextV2',key,bindings:[[0,null,null]],roads:[]}));
  const contexts=new Uint8Array(36),view=new DataView(contexts.buffer),people=encodePersonShard(0,[{householdIndex:0,birthYear:1990,sex:'female',scenarioMask:7,entryYear:2026}]);contexts.set(people.subarray(32,48),4);
  [0,SPATIAL_NONE,SPATIAL_NONE,SPATIAL_NONE].forEach((v,i)=>view.setUint32(20+i*4,v,true));
  const page=await asset(`cells/${key}/pages/0000`,encodeMovementPage({key,contexts,households:[{householdIndex:0,members:[[0,Buffer.from(people.subarray(32,48)).toString('base64')]]}],buildings:[{index:0,id:'openmaptiles_buildings:1',center:[61.39466,55.1654],districtId:'RU-CHE-SET-CEN',use:'residential'}]}));
  const context=await asset(`cells/${key}/context`,json({contract:'DemoMovementCellContextV2',key,bindings:[[0,null,null]],roads:[]}));
  const manifest={contract:'DemoMovementOverlayV2',version:'source-mode-v2',datasetId:'omnitwin-fictional-city-v2',representation:'visual_synthesis',scientificClaim:false,scope:'local_preview',chatCompatibility:'pending',baseHashes,overlayCodecSha256:codeHashes.movementRoadPolicy,
    bounds:[61.39,55.16,61.4,55.17],sourceBounds:[61.38,55.15,61.41,55.18],origin:[61.39466,55.1654],coveredBuildingIndices:[0],indexNamespace:{kind:'local_overlay',sourceRoadIndexBase:1000000,ordering:'lexicographic_verified_source_road_id',notGlobalGeographyOrdinals:true},
    bindings,cells:[{key,bbox:[61.39,55.16,61.4,55.17],count:1,context,pages:[{...page,count:1,firstPersonIndex:0,lastPersonIndex:0}]}],cellZoom:16,pageSize:2048,maxPageSize:8192,maxPageBytes:8388608,recordCount:1,householdCount:1,buildingCount:1,
    sourceHashes:{populationManifest:baseHashes.population,geographyManifest:baseHashes.geography,baseSpatialManifest:baseHashes.spatial,buildingIndex:'a'.repeat(64),...codeHashes,routeCorridorCodec:'b'.repeat(64),compiler:'c'.repeat(64)},stats:{cells:1,pages:1,coveredBuildings:1},semantics:{scope:'fixture'}};
  const save=async()=>{const bytes=json(manifest),manifestSha256=sha(bytes),manifestName=`manifest-${manifestSha256.slice(0,16)}.json`;await put(overlayRoot,manifestName,bytes);return {overlayRoot,publicRoot,manifestName,manifestSha256};};
  return {root,overlayRoot,publicRoot,manifest,save,put,options:await save()};
}
test('plans only exact overlay resources, preserves gzip aliases and keeps chat attestation pending',async t=>{
  const f=await fixture(t),plan=await planCityMovementAssets(f.options),summary=summarizeCityMovementPlan(plan);
  assert.equal(plan.objects.length,7);assert.equal(plan.objects.filter(o=>o.contentEncoding==='gzip').length,3);
  assert.equal(summary.activation.manifest.sha256,f.options.manifestSha256);assert.equal(summary.activation.chatCompatibility,'pending');assert.equal(summary.publicReady,false);
  assert.ok(!JSON.stringify(summary).includes(f.root));assert.ok(!plan.objects.some(o=>o.path.includes('demo-v2/')));
});
test('corruption, mismatched gzip and missing members prevent a verified plan',async t=>{
  const f=await fixture(t);await f.put(f.overlayRoot,f.manifest.bindings.url,Buffer.alloc(f.manifest.bindings.bytes));await assert.rejects(planCityMovementAssets(f.options),/integrity|digest/i);
  const g=await fixture(t),d=g.manifest.bindings,gzip=gzipSync('{}');d.gzip=await g.put(g.overlayRoot,d.url+'.gz',gzip);await assert.rejects(planCityMovementAssets(await g.save()),/gzip/i);
  const h=await fixture(t);h.manifest.cells[0].pages=[];await assert.rejects(planCityMovementAssets(await h.save()),/count|closure|page/i);
});
test('source pins, path escapes, duplicate membership and unknown descriptor families fail closed',async t=>{
  for(const change of [m=>{m.baseHashes.population='f'.repeat(64);},m=>{m.bindings.url='../outside.json';},m=>{m.cells.push(m.cells[0]);m.stats.cells=2;},m=>{m.hidden={url:'hidden.json',bytes:1,sha256:'f'.repeat(64)};}]){
    const f=await fixture(t);change(f.manifest);await assert.rejects(planCityMovementAssets(await f.save()));
  }
});
test('source changes after planning fail before authentication and serialized plans are not capabilities',async t=>{
  const f=await fixture(t),plan=await planCityMovementAssets(f.options);let auth=0;
  const options={bucket:'omnitwin-demo-city-assets',getAccessToken:async()=>{auth++;return 'fixture';},fetchImpl:()=>{throw Error('forbidden');}};
  await assert.rejects(publishCityMovementAssets(JSON.parse(JSON.stringify(plan)),options),/verified/i);
  await f.put(f.publicRoot,'demo-v2/manifest.json',json({changed:true}));await assert.rejects(publishCityMovementAssets(plan,options),/changed|size|digest/i);assert.equal(auth,0);
});
test('uploads verified gzip representations with root last, create-only resume and exact delivery metadata',async t=>{
  const f=await fixture(t),plan=await planCityMovementAssets(f.options),remote=new Map(),posted=[];
  let active=0,peak=0;
  const resource=o=>({name:o.name,size:String(o.storedBytes),md5Hash:o.md5Hash,contentType:o.contentType,cacheControl:o.cacheControl,...(o.contentEncoding?{contentEncoding:o.contentEncoding}:{}),metadata:o.metadata,generation:'1'});
  const fetchImpl=async(url,init)=>{
    const u=new URL(url);assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer fixture-token');
    if(u.pathname.endsWith('/b/omnitwin-demo-city-assets'))return Response.json({name:'omnitwin-demo-city-assets',projectNumber:PROJECT_NUMBER});
    if(init.method==='GET'){const name=decodeURIComponent(u.pathname.split('/o/')[1]);return remote.has(name)?Response.json(remote.get(name)):new Response('',{status:404});}
    assert.equal(init.method,'POST');assert.equal(u.searchParams.get('ifGenerationMatch'),'0');const object=plan.objects.find(o=>o.name===u.searchParams.get('name'));assert.ok(object);
    if(object.path===f.options.manifestName)for(const o of plan.objects.filter(o=>o.path!==f.options.manifestName))assert.ok(remote.has(o.name));
    const payload=Buffer.from(init.body),boundary=init.headers['Content-Type'].split('boundary=')[1],marker=Buffer.from(`Content-Type: ${object.contentType}\r\n\r\n`);
    const bytes=payload.subarray(payload.indexOf(marker)+marker.length,payload.length-Buffer.byteLength(`\r\n--${boundary}--\r\n`));assert.equal(sha(bytes),object.sha256);assert.equal(bytes.length,object.storedBytes);
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;posted.push(object.path);remote.set(object.name,resource(object));return Response.json(resource(object));
  };
  const options={bucket:'omnitwin-demo-city-assets',getAccessToken:async()=> 'fixture-token',fetchImpl};
  assert.equal((await publishCityMovementAssets(plan,options)).uploaded,7);assert.equal(peak,2);assert.equal(posted.at(-1),f.options.manifestName);
  assert.equal((await publishCityMovementAssets(plan,options)).skipped,7);assert.equal(posted.length,7);
  const opaque=plan.objects.find(o=>o.path.endsWith('.gz'));remote.set(opaque.name,{...resource(opaque),contentEncoding:'gzip'});
  await assert.rejects(publishCityMovementAssets(plan,options),/conflict/i);assert.equal(posted.length,7);
});
