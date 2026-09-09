import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {planCityVisualAssets,publishCityVisualAssets,summarizeCityVisualPlan,writeVisualPublicationReport} from '../publish-city-visual-assets.mjs';
import {PROJECT_NUMBER} from '../publish-firebase-city-assets.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex'),json=x=>Buffer.from(JSON.stringify(x)+'\n');
const source={packId:'fixture-city',datasetVersion:'a'.repeat(64),manifestSha256:'b'.repeat(64)};
const id=n=>`openmaptiles_buildings:${n}`;
function glb(ids,image,patch={}){
  const data=json({asset:{version:'2.0'},buffers:[{byteLength:0}],meshes:[{extras:{featureRanges:ids.map(canonicalId=>({canonicalId,startIndex:0,indexCount:3}))}}],images:[{uri:image}],...patch});
  const padded=Buffer.concat([data,Buffer.alloc((4-data.length%4)%4,32)]),header=Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(20+padded.length,8);header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16);
  return Buffer.concat([header,padded]);
}
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'omnitwin-visual-release-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const put=async(path,data)=>{await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),data);return {uri:path,bytes:data.length,sha256:hash(data)};};
  const image=Buffer.from([255,216,255,224,0,2,255,217]),imageHash=hash(image);
  const material={uri:`materials/brick_wall_001-baseColor-${imageHash.slice(0,16)}.jpg`,bytes:image.length,sha256:imageHash,role:'baseColor',sourceId:'brick_wall_001',width:1024,height:1024,colorSpace:'srgb'};
  const library={contract:'CityMaterialLibraryV2',version:2,mode:'metric_repeat',representation:'visual_synthesis',provider:'Poly Haven',license:'CC0-1.0',licenseUrl:'https://polyhaven.com/license',sourceCatalogSha256:'c'.repeat(64),assets:[material],materials:{brick:{baseColorUri:`../${material.uri}`,repeatMeters:[2,2]}}};
  async function pack(base,ids,shared=false){
    const bytes=glb(ids,`../${material.uri}`),tile=await put(`${base}tiles/coarse-${hash(bytes).slice(0,16)}.glb`,bytes);tile.uri=tile.uri.slice(base.length);tile.canonicalIds=ids;
    const tileset=await put(`${base}tileset.json`,json({asset:{version:'1.1',tilesetVersion:'omnitwin-city-visual-v1'},root:{refine:'REPLACE',content:{uri:tile.uri}}}));tileset.uri='tileset.json';
    const semantics=await put(`${base}semantics.json`,json({contract:'CityVisualSemanticsV1',sourceDatasetVersion:source.datasetVersion,buildings:Object.fromEntries(ids.map(i=>[i,{}]))}));semantics.uri='semantics.json';
    if(!shared)await put(base+material.uri,image);
    const manifest={contract:'CityVisualPackManifestV1',version:1,coordinateSystem:'east-up-south',tileFrame:'east-north-up_to_ecef',coverage:'bounded_quarter',origin:[61.4,55.16,0],bounds:[61.39,55.15,61.42,55.18],source,
      populationCompatibility:{datasetId:'omnitwin-fictional-city-v2',sourceDatasetVersion:source.datasetVersion,canonicalIds:ids,reassignments:0,populationMutated:false},tileset,semantics,assets:[tile],textureAssets:[],materialLibrary:library};
    return {manifest,save:()=>put(base+'manifest.json',json(manifest))};
  }
  const catalogBase='catalog/build-fixture/';await put(catalogBase+material.uri,image);
  const cells=[];
  for(const n of [1,2]){
    const temporary=`fixture-${n}/`,cell=await pack(temporary,[id(n)],true),body=json(cell.manifest),digest=hash(body),base=`${catalogBase}cells/cell-${n}/${digest}/`;
    for(const asset of [cell.manifest.tileset,cell.manifest.semantics,...cell.manifest.assets])await put(base+asset.uri,await readFile(join(root,temporary+asset.uri)));
    const descriptor=await put(base+'manifest.json',body);descriptor.uri=descriptor.uri.slice(catalogBase.length);
    cells.push({key:`cell-${n}`,bounds:cell.manifest.bounds,canonicalIds:[id(n)],manifest:descriptor,estimatedResidentBytes:100,lodLevels:1});
  }
  const catalog={contract:'CityVisualCatalogV1',version:1,catalogId:'fixture',coordinateSystem:'east-up-south',populationDatasetId:'omnitwin-fictional-city-v2',source,bounds:[61.39,55.15,61.42,55.18],coverage:{status:'complete',plannedCells:2,compiledCells:2,emptyCells:0},cells,materialLibrary:library};
  const catalogDescriptor=await put(catalogBase+'catalog.json',json(catalog));
  const main=await pack('',[id(1),id(2)]);main.manifest.visualCatalog=catalogDescriptor;await main.save();
  await put('unreferenced-secret.env',Buffer.from('not-an-upload'));
  return {root,put,main,catalog,catalogBase,material,saveCatalog:async()=>{main.manifest.visualCatalog=await put(catalogBase+'catalog.json',json(catalog));await main.save();}};
}
function transport(plan,{race=false}={}){
  const remote=new Map(),posted=[];let active=0,peak=0;
  const resource=o=>({name:o.name,size:String(o.storedBytes),md5Hash:o.md5Hash,contentType:o.contentType,cacheControl:o.cacheControl,metadata:o.metadata,generation:'1'});
  const fetchImpl=async(url,init)=>{
    assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.headers.Authorization,'Bearer fixture-token');
    const u=new URL(url);
    if(u.pathname.endsWith('/b/omnitwin-demo-city-assets'))return Response.json({name:'omnitwin-demo-city-assets',projectNumber:PROJECT_NUMBER});
    if(init.method==='GET'){const name=decodeURIComponent(u.pathname.split('/o/')[1]);return remote.has(name)?Response.json(remote.get(name)):new Response('',{status:404});}
    assert.equal(init.method,'POST');assert.equal(u.searchParams.get('ifGenerationMatch'),'0');assert.equal(u.searchParams.get('uploadType'),'multipart');assert.equal(u.searchParams.has('predefinedAcl'),false);
    const object=plan.objects.find(o=>o.name===u.searchParams.get('name'));assert.ok(object);posted.push(object.path);
    const body=Buffer.from(init.body),boundary=init.headers['Content-Type'].split('boundary=')[1];
    const start=body.indexOf(Buffer.from(`Content-Type: ${object.contentType}\r\n\r\n`))+Buffer.byteLength(`Content-Type: ${object.contentType}\r\n\r\n`);
    const actual=body.subarray(start,body.length-Buffer.byteLength(`\r\n--${boundary}--\r\n`));
    assert.equal(actual.length,object.storedBytes);assert.equal(hash(actual),object.sha256);
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;
    remote.set(object.name,resource(object));return race?new Response('',{status:412}):Response.json(resource(object));
  };
  return {remote,posted,resource,fetchImpl,get peak(){return peak;}};
}
const uploadOptions=fetchImpl=>({bucket:'omnitwin-demo-city-assets',getAccessToken:async()=> 'fixture-token',fetchImpl});
test('plans exact root/catalog/cell closure with shared material only once per actual URL and an independent pin',async t=>{
  const f=await fixture(t),plan=await planCityVisualAssets({visualRoot:f.root});
  assert.equal(plan.objects.filter(o=>o.path.endsWith('.jpg')).length,2);assert.equal(plan.objects.length,15);
  assert.ok(!plan.objects.some(o=>o.path.includes('fixture-1')||o.path.includes('secret')));
  const summary=summarizeCityVisualPlan(plan);assert.equal(summary.activation.manifest.sha256,hash(await readFile(join(f.root,'manifest.json'))));
  assert.ok(summary.activation.manifest.url.endsWith(`/packs/${plan.releaseId}/city-visual-v1/manifest.json`));
  assert.ok(!JSON.stringify(summary).includes(f.root));assert.equal(summary.publicReady,false);
});
test('rejects corrupted leaf bytes before creating a verified plan',async t=>{
  const f=await fixture(t);await f.put(f.catalogBase+f.material.uri,Buffer.alloc(f.material.bytes,1));
  await assert.rejects(planCityVisualAssets({visualRoot:f.root}),/size|digest|integrity/i);
});
test('rejects escapes, duplicate ownership and incomplete publication catalogs',async t=>{
  const f=await fixture(t);f.main.manifest.visualCatalog.uri='../catalog.json';await f.main.save();
  await assert.rejects(planCityVisualAssets({visualRoot:f.root}),/path|scope|escape/i);
  await f.saveCatalog();f.catalog.cells[1].canonicalIds=[id(1)];await f.saveCatalog();
  await assert.rejects(planCityVisualAssets({visualRoot:f.root}),/duplicate|ownership/i);
  f.catalog.cells[1].canonicalIds=[id(2)];f.catalog.coverage={status:'partial',plannedCells:3,compiledCells:2,emptyCells:0};await f.saveCatalog();
  await assert.rejects(planCityVisualAssets({visualRoot:f.root}),/complete|partial/i);
});
test('rejects hidden asset families and missing manifest dependencies',async t=>{
  const f=await fixture(t);f.main.manifest.extraAsset={uri:'hidden.png',bytes:1,sha256:'f'.repeat(64)};await f.main.save();
  await assert.rejects(planCityVisualAssets({visualRoot:f.root}),/unrecognized|family/i);
  delete f.main.manifest.extraAsset;await f.main.save();await rm(join(f.root,f.catalogBase+f.catalog.cells[0].manifest.uri));
  await assert.rejects(planCityVisualAssets({visualRoot:f.root}),/missing|read|file/i);
});
test('unknown URL descriptor families fail closed, without treating attribution URLs as runtime assets',async t=>{
  const f=await fixture(t);f.main.manifest.license={sourceLedger:[{sourceId:'upstream',url:'https://source.invalid/not-an-upload.json',bytes:123456789,sha256:'e'.repeat(64)}]};await f.main.save();
  assert.equal((await planCityVisualAssets({visualRoot:f.root})).objects.length,15);
  f.main.manifest.extraAsset={url:'hidden.png',bytes:1,sha256:'f'.repeat(64)};await f.main.save();
  await assert.rejects(planCityVisualAssets({visualRoot:f.root}),/unrecognized|family/i);
});
test('rejects GLB foreign buffers, undeclared images and incomplete canonical replacement ownership',async t=>{
  for(const patch of [{buffers:[{uri:'https://foreign.example/a.bin',byteLength:1}]},{images:[{uri:'../materials/undeclared.jpg'}]},{meshes:[{extras:{canonicalId:id(1)}}]}]){
    const f=await fixture(t),bytes=glb([id(1),id(2)],`../${f.material.uri}`,patch);
    const asset=await f.put(`tiles/coarse-${hash(bytes).slice(0,16)}.glb`,bytes);asset.canonicalIds=[id(1),id(2)];f.main.manifest.assets=[asset];
    f.main.manifest.tileset=await f.put('tileset.json',json({root:{refine:'REPLACE',content:{uri:asset.uri}}}));await f.main.save();
    await assert.rejects(planCityVisualAssets({visualRoot:f.root}),/GLB|ownership|closure|canonical/i);
  }
});
test('rejects duplicate GLB inventory and junctions inside the approved root',async t=>{
  const f=await fixture(t);f.main.manifest.assets.push(f.main.manifest.assets[0]);await f.main.save();
  await assert.rejects(planCityVisualAssets({visualRoot:f.root}),/duplicate/i);
  const g=await fixture(t),outside=await mkdtemp(join(tmpdir(),'omnitwin-visual-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  const leaf=g.main.manifest.assets[0];await writeFile(join(outside,leaf.uri.split('/').at(-1)),await readFile(join(g.root,leaf.uri)));
  await rm(join(g.root,'tiles'),{recursive:true});await symlink(outside,join(g.root,'tiles'),'junction');
  await assert.rejects(planCityVisualAssets({visualRoot:g.root}),/symlink|escape/i);
});
test('revalidates local bytes before auth and refuses unverified serialized plans',async t=>{
  const f=await fixture(t),plan=await planCityVisualAssets({visualRoot:f.root});let auth=0;
  const options={bucket:'omnitwin-demo-city-assets',getAccessToken:async()=>{auth++;return 'test';},fetchImpl:()=>{throw Error('network forbidden');}};
  await assert.rejects(publishCityVisualAssets(JSON.parse(JSON.stringify(plan)),options),/verified|process/i);
  await f.put(f.material.uri,Buffer.from('changed'));await assert.rejects(publishCityVisualAssets(plan,options),/size|digest|integrity/i);assert.equal(auth,0);
});
test('writes report atomically without replacing a different existing report',async t=>{
  const f=await fixture(t),path=join(f.root,'reports','plan.json'),value={releaseId:'a'.repeat(64)};
  await writeVisualPublicationReport(path,value);await writeVisualPublicationReport(path,value);
  await assert.rejects(writeVisualPublicationReport(path,{releaseId:'b'.repeat(64)}),/exists|differs|immutable/i);
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),value);
});
test('publishes exact identity bytes leaves before cells, catalog then root, with bounded concurrency and safe resume',async t=>{
  const f=await fixture(t),plan=await planCityVisualAssets({visualRoot:f.root}),mock=transport(plan),nested=new Set(Object.keys(plan.dependentManifestHashes));
  const fetchImpl=async(url,init)=>{
    if(init.method==='POST'){
      const path=new URL(url).searchParams.get('name').slice(plan.prefix.length);
      if(nested.has(path))for(const o of plan.objects.filter(o=>o.path!=='manifest.json'&&!nested.has(o.path)))assert.ok(mock.remote.has(o.name),'all leaves must exist before any nested manifest');
      if(path===plan.catalog.path)for(const o of plan.objects.filter(o=>o.path.endsWith('/manifest.json')))assert.ok(mock.remote.has(o.name),'cell manifests must precede the catalog');
      if(path==='manifest.json')for(const o of plan.objects.filter(o=>o.path!=='manifest.json'))assert.ok(mock.remote.has(o.name),'root must follow every dependency');
    }
    return mock.fetchImpl(url,init);
  };
  const first=await publishCityVisualAssets(plan,uploadOptions(fetchImpl));assert.equal(first.uploaded,15);assert.equal(mock.peak,2);assert.equal(first.publicReady,false);
  assert.deepEqual(mock.posted.slice(-2),[plan.catalog.path,'manifest.json']);assert.deepEqual(first.activation,plan.activation);
  assert.equal((await publishCityVisualAssets(plan,uploadOptions(fetchImpl))).skipped,15);assert.equal(mock.posted.length,15);
});
test('visual resume verifies concurrent creation and rejects altered checksum, delivery headers or provenance',async t=>{
  const f=await fixture(t),plan=await planCityVisualAssets({visualRoot:f.root}),race=transport(plan,{race:true});
  const raced=await publishCityVisualAssets(plan,uploadOptions(race.fetchImpl));assert.equal(raced.skipped,15);assert.equal(raced.uploaded,0);
  for(const patch of [{md5Hash:'incorrect'},{contentEncoding:'gzip'},{contentType:'text/plain'},{metadata:{sha256:'0'.repeat(64)}}]){
    const mock=transport(plan),object=plan.objects[0];mock.remote.set(object.name,{...mock.resource(object),...patch});
    await assert.rejects(publishCityVisualAssets(plan,uploadOptions(mock.fetchImpl)),/conflict/i);assert.ok(!mock.posted.includes('manifest.json'));
  }
});
test('partial inspection plans cannot reach authentication or publication',async t=>{
  const f=await fixture(t);f.catalog.coverage={status:'partial',plannedCells:3,compiledCells:2,emptyCells:0};await f.saveCatalog();
  const plan=await planCityVisualAssets({visualRoot:f.root,requireComplete:false});let auth=0;
  await assert.rejects(publishCityVisualAssets(plan,{...uploadOptions(()=>{throw Error('forbidden');}),getAccessToken:async()=>{auth++;return 'fixture-token';}}),/partial|dry-run/i);assert.equal(auth,0);
});
