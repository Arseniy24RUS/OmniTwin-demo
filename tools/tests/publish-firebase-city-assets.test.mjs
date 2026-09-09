import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { planFirebaseCityAssets, publishFirebaseCityAssets, summarizeFirebaseCityPlan, PROJECT_NUMBER, PUBLICATION_LIMITS } from '../publish-firebase-city-assets.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, mutate = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'omnitwin-upload-test-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const put = async (path, bytes) => {await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes);};
  const asset = async (base, url, text, compressed = true) => {
    const bytes=Buffer.from(text);await put(`${base}/${url}`,bytes);
    const result={url,sha256:hash(bytes),bytes:bytes.length};
    if(compressed){const gzip=gzipSync(bytes);await put(`${base}/${url}.gz`,gzip);result.gzip={url:`${url}.gz`,sha256:hash(gzip),bytes:gzip.length};}
    return result;
  };
  const city={contract:'DemoCityPackManifestV2',semantics:{populationTagsImported:false},
    boundaries:await asset('city-v2','pack/boundaries.json','{"type":"FeatureCollection"}'),
    buildingIndex:await asset('city-v2','pack/buildings.json','{"rows":[]}'),
    roadIndex:await asset('city-v2','pack/roads.json','{"roads":[]}'),buildingPages:[],cells:[],
    sourceLedger:[{url:'https://source.example/raw.json',sha256:'a'.repeat(64),bytes:500}],licenses:[]};
  const population={contract:'DemoPopulationManifestV2',datasetId:'omnitwin-fictional-city-v2',representation:'fictional_demo',scientificClaim:false,predictiveValidation:false,
    personShards:[await asset('demo-v2','people/p.bin','fictional-person',false)],householdShards:[],
    summaries:await asset('demo-v2','summaries.json','{"population":1}',false),queryIndex:await asset('demo-v2','query.json','{"index":1}',false)};
  const role=await asset('demo-v2/spatial','roles/r.bin','role');
  role.contexts=await asset('demo-v2/spatial','contexts/c.bin','context');
  role.contexts.householdTripMasks=await asset('demo-v2/spatial','masks/m.bin','mask');
  const spatial={contract:'DemoSpatialManifestV2',datasetId:population.datasetId,representation:'visual_synthesis',scientificClaim:false,
    targetShards:[],roleShards:[role],bindingShards:[],candidateCells:[],sourceHashes:{}};
  await mutate({root,city,population,spatial,put,asset});
  const cityBytes=Buffer.from(JSON.stringify(city));await put('city-v2/manifest.json',cityBytes);
  population.spatial??={geographyManifestUrl:'../city-v2/manifest.json',geographyManifestSha256:hash(cityBytes),buildingIndex:{...city.buildingIndex,url:`../city-v2/${city.buildingIndex.url}`,gzip:city.buildingIndex.gzip?{...city.buildingIndex.gzip,url:`../city-v2/${city.buildingIndex.gzip.url}`}:undefined}};
  const populationBytes=Buffer.from(JSON.stringify(population));await put('demo-v2/manifest.json',populationBytes);
  spatial.sourceHashes={populationManifest:hash(populationBytes),geographyManifest:hash(cityBytes),buildingIndex:city.buildingIndex.sha256,roadIndex:city.roadIndex.sha256,...spatial.sourceHashes};
  await put('demo-v2/spatial/manifest.json',JSON.stringify(spatial));
  await put('demo-v2/obsolete.bin','never-upload');await put('demo-v2/.env','never-read');await put('science/raw.bin','never-read');
  return {root,put,asset,city,population,spatial};
}

async function movementFixture(t, mutate = () => {}) {
  const f = await fixture(t, ({population,spatial}) => {
    population.recordCount=1; population.householdCount=1;
    spatial.recordCount=1; spatial.householdCount=1; spatial.buildingCount=1;
    Object.assign(spatial.sourceHashes,{populationCodec:'b'.repeat(64),spatialCodec:'c'.repeat(64),routeCorridorCodec:'d'.repeat(64)});
  });
  const base='demo-v2/spatial/movement';
  const context=await f.asset(base,'cells/16/43945/20668/context.json',JSON.stringify({contract:'DemoMovementCellContextV2',key:'16/43945/20668',bindings:[],roads:[]}));
  const page=await f.asset(base,'cells/16/43945/20668/page-0.json',JSON.stringify({contract:'DemoMovementPageV2',key:'16/43945/20668',count:1,contextsBase64:'',households:[],buildings:[]}));
  const {populationManifest,geographyManifest,buildingIndex,populationCodec,spatialCodec,routeCorridorCodec}=f.spatial.sourceHashes;
  const movement={contract:'DemoMovementIndexManifestV2',datasetId:f.population.datasetId,representation:'visual_synthesis',scientificClaim:false,
    recordCount:1,householdCount:1,buildingCount:1,cellZoom:16,pageSize:2048,maxPageSize:8192,maxPageBytes:8*1024*1024,
    sourceHashes:{populationManifest,geographyManifest,buildingIndex,populationCodec,spatialCodec,routeCorridorCodec,baseSpatialManifest:hash(`${JSON.stringify(f.spatial)}\n`),codec:'e'.repeat(64),compiler:'f'.repeat(64)},
    cells:[{key:'16/43945/20668',bbox:[61.4,55.16,61.41,55.17],count:1,context,pages:[{...page,count:1,firstPersonIndex:0,lastPersonIndex:0}]}]};
  const saveMovement=async()=>{
    const descriptor=await f.asset(base,'manifest-current.json',JSON.stringify(movement));
    f.spatial.movementIndex={...descriptor,url:`movement/${descriptor.url}`,gzip:{...descriptor.gzip,url:`movement/${descriptor.gzip.url}`}};
    await f.put('demo-v2/spatial/manifest.json',JSON.stringify(f.spatial));
  };
  await mutate({ ...f, movement, base }); await saveMovement();
  return {...f,movement,base,saveMovement};
}
function transport(plan, {projectNumber=PROJECT_NUMBER, mismatch=false, race=false, gate} = {}) {
  const calls=[];const remote=new Map();let active=0;let peak=0;let posts=0;
  const resource=object=>({name:object.name,size:String(object.storedBytes),md5Hash:object.md5Hash,contentType:object.contentType,...(object.contentEncoding?{contentEncoding:object.contentEncoding}:{}),cacheControl:object.cacheControl,metadata:object.metadata,generation:'1'});
  if(mismatch){const object=plan.objects[0];remote.set(object.name,{...resource(object),metadata:{...object.metadata,sha256:'0'.repeat(64)}});}
  const fetchImpl=async(url,init)=>{
    calls.push({url:String(url),...init});assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.headers.Authorization,'Bearer unit-test-not-a-credential');
    const u=new URL(url);
    if(u.pathname.endsWith('/b/omnitwin-demo-city-assets'))return Response.json({name:'omnitwin-demo-city-assets',projectNumber});
    if(init.method==='GET'){const name=decodeURIComponent(u.pathname.split('/o/')[1]);return remote.has(name)?Response.json(remote.get(name)):new Response('',{status:404});}
    assert.equal(init.method,'POST');assert.equal(u.searchParams.get('ifGenerationMatch'),'0');assert.equal(u.searchParams.get('uploadType'),'multipart');
    assert.equal(u.searchParams.has('predefinedAcl'),false);
    const object=plan.objects.find(item=>item.name===u.searchParams.get('name'));assert.ok(object);
    const body=Buffer.from(init.body);assert.ok(body.includes(Buffer.from(JSON.stringify({name:object.name,contentType:object.contentType,cacheControl:object.cacheControl,...(object.contentEncoding?{contentEncoding:object.contentEncoding}:{}),md5Hash:object.md5Hash,metadata:object.metadata}))));
    posts++;active++;peak=Math.max(peak,active);if(gate)await gate();active--;
    remote.set(object.name,resource(object));return race?new Response('',{status:412}):Response.json(resource(object));
  };
  return {fetchImpl,remote,calls,resource,get peak(){return peak},get posts(){return posts}};
}
const options=fetchImpl=>({projectId:'omnitwin-demo',bucket:'omnitwin-demo-city-assets',getAccessToken:async()=> 'unit-test-not-a-credential',fetchImpl});

test('expanded current closure has an explicit 8GiB ceiling without changing object, body or concurrency caps',()=>{
  assert.equal(PUBLICATION_LIMITS.totalBytes,8*1024**3);
  assert.equal(PUBLICATION_LIMITS.objects,40000);
  assert.equal(PUBLICATION_LIMITS.assetBytes,64*1024*1024);
  assert.equal(PUBLICATION_LIMITS.concurrency,2);
});

test('offline plan includes only declared current families, deduplicates links and preserves gzip semantics', async t=>{
  const f=await fixture(t);const plan=await planFirebaseCityAssets({publicRoot:f.root});
  const summary=summarizeFirebaseCityPlan(plan);
  assert.match(plan.releaseId,/^[a-f0-9]{64}$/);assert.equal(plan.prefix,`packs/${plan.releaseId}/`);
  assert.equal(plan.objects.length,18);assert.equal(summary.objectCount,18);assert.ok(summary.totalStoredBytes>0);
  assert.ok(summary.excludedFamilies.includes('city-v2.sourceLedger (upstream raw URLs)'));
  assert.ok(plan.objects.every(o=>!o.name.includes('obsolete')&&!o.name.includes('.env')&&!o.name.includes('science')));
  const raw=plan.objects.find(o=>o.path==='city-v2/pack/buildings.json');const gzip=plan.objects.find(o=>o.path==='city-v2/pack/buildings.json.gz');
  assert.equal(raw.contentEncoding,'gzip');assert.equal(raw.contentType,'application/json; charset=utf-8');assert.equal(raw.metadata.rawSha256,f.city.buildingIndex.sha256);
  assert.equal(gzip.contentEncoding,undefined);assert.equal(gzip.contentType,'application/gzip');assert.equal(gzip.metadata.sha256,f.city.buildingIndex.gzip.sha256);
  assert.equal((await planFirebaseCityAssets({publicRoot:f.root})).releaseId,plan.releaseId);
  await assert.rejects(planFirebaseCityAssets({publicRoot:f.root,gzipAliases:false}),/aliases/);
});

test('optional movement manifest closes over every relative context/page and both gzip representations',async t=>{
  const f=await movementFixture(t);const plan=await planFirebaseCityAssets({publicRoot:f.root});
  assert.equal(plan.objects.length,24);
  for(const leaf of ['manifest-current.json','cells/16/43945/20668/context.json','cells/16/43945/20668/page-0.json']){
    const raw=plan.objects.find(o=>o.path===`${f.base}/${leaf}`);const gzip=plan.objects.find(o=>o.path===`${f.base}/${leaf}.gz`);
    assert.ok(raw);assert.ok(gzip);assert.equal(raw.contentEncoding,'gzip');assert.equal(raw.contentType,'application/json; charset=utf-8');
    assert.equal(gzip.contentEncoding,undefined);assert.equal(gzip.contentType,'application/gzip');
  }
  assert.equal(summarizeFirebaseCityPlan(plan).dependentManifestHashes[`${f.base}/manifest-current.json`],f.spatial.movementIndex.sha256);
  const before=plan.releaseId;f.movement.semantics={note:'public fictional metadata changed'};await f.saveMovement();
  assert.notEqual((await planFirebaseCityAssets({publicRoot:f.root})).releaseId,before,'nested descriptor is pinned by the spatial root and changes the pack hash');
});

test('movement manifest and leaf integrity failures prevent any usable publication plan',async t=>{
  for(const leaf of ['manifest-current.json','cells/16/43945/20668/context.json','cells/16/43945/20668/page-0.json.gz']){
    const f=await movementFixture(t);await f.put(`${f.base}/${leaf}`,'bad');
    await assert.rejects(planFirebaseCityAssets({publicRoot:f.root}),/size|digest/i);
  }
  const missing=await movementFixture(t);await rm(join(missing.root,missing.base,'cells/16/43945/20668/page-0.json'));
  await assert.rejects(planFirebaseCityAssets({publicRoot:missing.root}),/ENOENT/);
});

test('movement lineage, required contexts, child scopes and unknown nested families fail closed',async t=>{
  for(const mutate of [
    ({movement})=>{movement.contract='unapproved';},
    ({movement})=>{movement.sourceHashes.populationManifest='0'.repeat(64);},
    ({movement})=>{movement.sourceHashes.spatialCodec='0'.repeat(64);},
    ({movement})=>{movement.sourceHashes.baseSpatialManifest='0'.repeat(64);},
    ({movement})=>{delete movement.cells[0].context;},
    ({movement})=>{movement.cells[0].context.url='../roles/r.bin';},
    ({movement})=>{movement.cells[0].pages[0].count=2;},
    async({movement,asset,base})=>{movement.newRuntimeIndex=await asset(base,'unapproved.json','{}');},
  ]){
    const f=await movementFixture(t,mutate);
    await assert.rejects(planFirebaseCityAssets({publicRoot:f.root}),/movement|manifest|descriptor|family|context|scope|asset/i);
  }
});

test('movement manifests publish only after their leaves, with spatial root last and safe resume',async t=>{
  const f=await movementFixture(t);const plan=await planFirebaseCityAssets({publicRoot:f.root});const mock=transport(plan,{gate:()=>new Promise(resolve=>setTimeout(resolve,3))});
  const nested=new Set([`${f.base}/manifest-current.json`,`${f.base}/manifest-current.json.gz`]);
  const roots=new Set(['city-v2/manifest.json','demo-v2/manifest.json','demo-v2/spatial/manifest.json']);
  const fetchImpl=async(url,init)=>{
    if(init.method==='POST'){
      const path=new URL(url).searchParams.get('name').slice(plan.prefix.length);
      if(nested.has(path))for(const o of plan.objects.filter(o=>!nested.has(o.path)&&!roots.has(o.path)))assert.ok(mock.remote.has(o.name),'nested manifest must not precede any leaf');
      if(roots.has(path))for(const o of plan.objects.filter(o=>!roots.has(o.path)))assert.ok(mock.remote.has(o.name),'root must not precede nested manifests');
    }
    return mock.fetchImpl(url,init);
  };
  await publishFirebaseCityAssets(plan,options(fetchImpl));
  assert.equal((await publishFirebaseCityAssets(plan,options(fetchImpl))).skipped,plan.objects.length);assert.ok(mock.peak<=2);
  const posted=mock.calls.filter(c=>c.method==='POST').map(c=>new URL(c.url).searchParams.get('name').slice(plan.prefix.length));
  assert.equal(posted.at(-1),'demo-v2/spatial/manifest.json');
  await f.put(`${f.base}/cells/16/43945/20668/context.json`,'changed');let auth=0;
  await assert.rejects(publishFirebaseCityAssets(plan,{...options(fetchImpl),getAccessToken:async()=>{auth++;return 'unit-test-not-a-credential';}}),/size|digest/i);assert.equal(auth,0);
});
test('bad local SHA or gzip equivalent fails before any auth or network work', async t=>{
  const f=await fixture(t);await f.put('demo-v2/people/p.bin','corrupted');
  await assert.rejects(planFirebaseCityAssets({publicRoot:f.root}),/size|digest/i);
  const wrong=await fixture(t,async({city,put})=>{const bytes=gzipSync('different');city.boundaries.gzip={url:'pack/boundaries.json.gz',sha256:hash(bytes),bytes:bytes.length};await put('city-v2/pack/boundaries.json.gz',bytes);});
  await assert.rejects(planFirebaseCityAssets({publicRoot:wrong.root}),/gzip|digest|size/i);
});
test('explicit empty binary roster companions are preserved and verified',async t=>{
  const f=await fixture(t,async({spatial,asset})=>{spatial.roleShards[0].contexts.householdTripMasks=await asset('demo-v2/spatial','masks/empty.bin','');});
  const plan=await planFirebaseCityAssets({publicRoot:f.root});
  const empty=plan.objects.find(o=>o.path==='demo-v2/spatial/masks/empty.bin');
  assert.equal(empty.rawBytes,0);assert.equal(empty.metadata.rawSha256,hash(Buffer.alloc(0)));assert.equal(empty.contentEncoding,'gzip');
});
test('new descriptor families cannot be silently omitted from a complete plan',async t=>{
  const f=await fixture(t,async({population,asset})=>{population.newRuntimeIndex=await asset('demo-v2','new-index.json','{}');});
  await assert.rejects(planFirebaseCityAssets({publicRoot:f.root}),/unrecognized|undeclared|family/i);
});
test('path escapes, source artifacts and inconsistent manifest bindings are rejected', async t=>{
  for(const url of ['../../science/raw.bin','../demo-v2/.env','https://remote.example/a.bin','%2e%2e/raw.bin']){
    const f=await fixture(t,({population})=>{population.personShards[0].url=url;});
    await assert.rejects(planFirebaseCityAssets({publicRoot:f.root}),/path|scope|asset/i);
  }
  const f=await fixture(t,({spatial})=>{spatial.sourceHashes.populationManifest='0'.repeat(64)});
  await assert.rejects(planFirebaseCityAssets({publicRoot:f.root}),/binding|manifest/i);
});
test('an internal symlink or junction cannot escape the approved public root',async t=>{
  const outside=await mkdtemp(join(tmpdir(),'omnitwin-upload-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  const data=Buffer.from('must-stay-outside');await writeFile(join(outside,'outside.bin'),data);
  const f=await fixture(t,async({root,population})=>{await mkdir(join(root,'demo-v2'),{recursive:true});await symlink(outside,join(root,'demo-v2','linked'),'junction');population.personShards[0]={url:'linked/outside.bin',sha256:hash(data),bytes:data.length};});
  await assert.rejects(planFirebaseCityAssets({publicRoot:f.root}),/escapes|symlink/i);
});
test('uploads are immutable, bounded to two and resumable only with exact remote metadata',async t=>{
  const f=await fixture(t);const plan=await planFirebaseCityAssets({publicRoot:f.root});
  const mock=transport(plan,{gate:()=>new Promise(resolve=>setTimeout(resolve,3))});
  const first=await publishFirebaseCityAssets(plan,options(mock.fetchImpl));assert.equal(first.uploaded,18);assert.equal(mock.peak,2);
  const posted=mock.calls.filter(call=>call.method==='POST').map(call=>new URL(call.url).searchParams.get('name').slice(plan.prefix.length));
  assert.deepEqual(posted.slice(-3),['city-v2/manifest.json','demo-v2/manifest.json','demo-v2/spatial/manifest.json']);
  const second=await publishFirebaseCityAssets(plan,options(mock.fetchImpl));assert.equal(second.skipped,18);assert.equal(mock.posts,18);
  assert.ok(mock.calls.every(c=>c.method==='GET'||c.method==='POST'));
});
test('explicit upload concurrency is bounded and preserves manifest-last ordering',async t=>{
  const f=await fixture(t),plan=await planFirebaseCityAssets({publicRoot:f.root});
  const mock=transport(plan,{gate:()=>new Promise(resolve=>setTimeout(resolve,10))});
  await publishFirebaseCityAssets(plan,{...options(mock.fetchImpl),concurrency:8});
  assert.equal(mock.peak,8);
  const posted=mock.calls.filter(call=>call.method==='POST').map(call=>new URL(call.url).searchParams.get('name').slice(plan.prefix.length));
  assert.deepEqual(posted.slice(-3),['city-v2/manifest.json','demo-v2/manifest.json','demo-v2/spatial/manifest.json']);
  for(const concurrency of [0,9,1.5,NaN,'8']){
    let auth=0;
    await assert.rejects(publishFirebaseCityAssets(plan,{...options(mock.fetchImpl),concurrency,getAccessToken:async()=>{auth++;return 'unused';}}),/concurrency/i);
    assert.equal(auth,0);
  }
});

test('existing mismatches and a bucket from another project stop without overwrite',async t=>{
  const f=await fixture(t);const plan=await planFirebaseCityAssets({publicRoot:f.root});
  const wrong=transport(plan,{projectNumber:'999'});await assert.rejects(publishFirebaseCityAssets(plan,options(wrong.fetchImpl)),/project/i);assert.equal(wrong.posts,0);
  const collision=transport(plan,{mismatch:true});await assert.rejects(publishFirebaseCityAssets(plan,options(collision.fetchImpl)),/conflict|mismatch/i);
  assert.ok(collision.calls.filter(c=>c.method==='POST').every(c=>new URL(c.url).searchParams.get('ifGenerationMatch')==='0'));
  let calls=0;await assert.rejects(publishFirebaseCityAssets(plan,{...options(()=>{calls++;}),bucket:'function-source-bucket'}),/dedicated bucket/);assert.equal(calls,0);
});
test('resume rejects native checksum, size and delivery-header mismatches without repairing them',async t=>{
  const f=await fixture(t);const plan=await planFirebaseCityAssets({publicRoot:f.root});
  for(const patch of [{md5Hash:'wrong'},{size:'9999'},{contentType:'text/plain'},{contentEncoding:'br'},{cacheControl:'no-store'}]){
    const mock=transport(plan);const expected=plan.objects[0];mock.remote.set(expected.name,{...mock.resource(expected),...patch});
    await assert.rejects(publishFirebaseCityAssets(plan,options(mock.fetchImpl)),/conflict/);
    assert.ok(!mock.calls.some(c=>c.method==='PATCH'||c.method==='DELETE'));
  }
});
test('a concurrent creation is skipped only after rechecking exact immutable metadata',async t=>{
  const f=await fixture(t);const plan=await planFirebaseCityAssets({publicRoot:f.root});const mock=transport(plan,{race:true});
  const result=await publishFirebaseCityAssets(plan,options(mock.fetchImpl));assert.equal(result.skipped,18);assert.equal(result.uploaded,0);
});
test('changed files after dry-run are rejected before authentication and publication',async t=>{
  const f=await fixture(t);const plan=await planFirebaseCityAssets({publicRoot:f.root});await f.put('demo-v2/people/p.bin','changed');let auth=0;
  await assert.rejects(publishFirebaseCityAssets(plan,{...options(()=>{throw new Error('network forbidden')}),getAccessToken:async()=>{auth++;return 'never';}}),/size|digest/i);
  assert.equal(auth,0);
});
test('credential and transport errors never expose supplied credential text',async t=>{
  const f=await fixture(t);const plan=await planFirebaseCityAssets({publicRoot:f.root});
  for(const change of [{getAccessToken:async()=>{throw new Error('SENSITIVE-TOKEN')}},{fetchImpl:async()=>{throw new Error('SENSITIVE-TOKEN')}}]){
    try{await publishFirebaseCityAssets(plan,{...options(()=>{}),...change});assert.fail('must reject')}catch(error){assert.equal(String(error).includes('SENSITIVE-TOKEN'),false);}
  }
});
test('aborting while a token provider stalls terminates without making a request',async t=>{
  const f=await fixture(t);const plan=await planFirebaseCityAssets({publicRoot:f.root});const abort=new AbortController();let started;let calls=0;
  const entered=new Promise(resolve=>{started=resolve});
  const pending=publishFirebaseCityAssets(plan,{...options(()=>{calls++;}),signal:abort.signal,getAccessToken:()=>{started();return new Promise(()=>{});}});
  await entered;abort.abort(new Error('SENSITIVE-TOKEN'));
  const outcome=await Promise.race([pending.then(()=> 'completed',error=>String(error).includes('SENSITIVE-TOKEN')?'leaked':'rejected'),new Promise(resolve=>setTimeout(()=>resolve('hung'),100))]);
  assert.equal(outcome,'rejected');assert.equal(calls,0);
});
test('metadata stream exceptions are sanitized before a CLI caller can print them',async t=>{
  const f=await fixture(t);const plan=await planFirebaseCityAssets({publicRoot:f.root});
  const fetchImpl=async()=>new Response(new ReadableStream({start(controller){controller.error(new Error('SENSITIVE-TOKEN'));}}));
  try{await publishFirebaseCityAssets(plan,options(fetchImpl));assert.fail('must reject')}catch(error){assert.equal(String(error).includes('SENSITIVE-TOKEN'),false);assert.match(String(error),/metadata|response/i);}
});
test('discarding 404 and 412 bodies cannot expose upstream cancellation errors',async t=>{
  const f=await fixture(t);const plan=await planFirebaseCityAssets({publicRoot:f.root});const mock=transport(plan,{race:true});let discarded=0;
  const fetchImpl=async(...args)=>{
    const response=await mock.fetchImpl(...args);
    if(response.status!==404&&response.status!==412)return response;
    return new Response(new ReadableStream({cancel(){discarded++;throw new Error('SENSITIVE-TOKEN');}}),{status:response.status});
  };
  const result=await publishFirebaseCityAssets(plan,options(fetchImpl));
  assert.equal(result.skipped,18);assert.equal(discarded,36);
});
