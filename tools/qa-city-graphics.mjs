#!/usr/bin/env node
/** Separate-context, bounded graphics regression. Does not touch the user's browser. */
import { chromium } from '@playwright/test';
import { mkdir,writeFile,readFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join,resolve,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const target='http://127.0.0.1:5178/OmniTwin-demo/';
const browserChannel=process.env.OMNITWIN_QA_BROWSER_CHANNEL??(process.platform==='win32'?'chrome':'chromium');
if(!['chrome','msedge','chromium'].includes(browserChannel))throw Error('Unsupported QA browser channel');
const expectedCatalog=process.argv[2]??JSON.parse(await readFile(join(root,'apps/web/public/city-visual-v1/manifest.json'),'utf8')).visualCatalog?.sha256;
if(typeof expectedCatalog!=='string'||!/^([a-f0-9]{64})$/.test(expectedCatalog))throw Error('Graphics QA requires one exact local preview catalog SHA');
const artifactRoot=join(tmpdir(),`omnitwin-city-graphics-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(artifactRoot,{recursive:true});
const start=Date.now(),deadline=start+290_000;
const report={startedAt:new Date(start).toISOString(),target,artifactRoot,classification:'contaminated_diagnostic',performanceClaim:false,
  browserPath:'Separately authorized standalone Playwright context; does not use the user in-app browser or a shared browser page',
  limits:{wallClockMs:290000,viewport:[1280,800]},catalogSha256:expectedCatalog,checks:[],samples:[],errors:[],console:[],network:[],screenshots:[],contexts:[],limitations:[
    'Ownership probe nativeIds are the declared exact-source complement; they are not a direct readback of MapLibre native geometry buckets.',
    'Native fallback requires screenshot inspection; render telemetry alone cannot prove every native extrusion pixel.',
    'Concurrent app/browser/compiler activity and recording contaminate performance measurements.']};
report.coverage={plannedZoomSamples:300,completedZoomSamples:0,plannedDistricts:7,completedDistricts:[],plannedFaults:5,completedFaults:[]};
let browser;
async function sourceFingerprint(){
  const sourceRoot=join(root,'apps/web/src'),files=(await readdir(sourceRoot,{recursive:true})).filter(name=>/\.(tsx?|css|json)$/.test(name)&&!name.includes('.test.')&&!name.includes('fixtures')).sort();
  const hash=createHash('sha256');for(const file of files){hash.update(file.replaceAll('\\','/'));hash.update(await readFile(join(sourceRoot,file)));}return hash.digest('hex');
}
report.sourceSha256Before=await sourceFingerprint();
const assert=(condition,name,detail={})=>{report.checks.push({name,pass:Boolean(condition),...detail});};
const remaining=()=>Math.max(0,deadline-Date.now());
const poses=[
  {name:'user',lon:61.40335931261333,lat:55.166641128116765,pitch:46.49661799282392,bearing:-172.97699800600026},
  {name:'center',lon:61.39466,lat:55.1654,pitch:55,bearing:-70},
  {name:'old-west',lon:61.385245372130555,lat:55.1654,pitch:48,bearing:20},
  {name:'old-east',lon:61.40407462786945,lat:55.1654,pitch:48,bearing:20},
  {name:'old-south',lon:61.39466,lat:55.16001045118695,pitch:48,bearing:20},
  {name:'old-north',lon:61.39466,lat:55.17078954881305,pitch:48,bearing:20}];
// Deterministic source-index probes selected from the seven district inventories.
const districtProbes=[['KUR',61.3421630859375,55.21335616000933],['KAL',61.3970947265625,55.18827648913107],
  ['CEN',61.3311767578125,55.150627359503285],['MET',61.4080810546875,55.25720758499866],
  ['SOV',61.3751220703125,55.106658425581735],['TRA',61.5179443359375,55.175730729671915],['LEN',61.4630126953125,55.11922591908764]];
const hash=(pose,zoom,paused=1)=>'#/world?'+new URLSearchParams({scenario:'baseline',year:'2026',territory:'RU-CHE-SET',minutes:'707.7335833333341',paused:String(paused),speed:'1',weather:'clear',
  lon:String(pose.lon),lat:String(pose.lat),zoom:String(zoom),pitch:String(pose.pitch),bearing:String(pose.bearing),stats:'observed',observedYear:'2024',dataset:'omnitwin-fictional-city-v2',graphics:'tiled_game'});
const compact=()=>{
  const el=document.querySelector('[data-testid="world-canvas"]'),p=el?.readGameOwnershipProbe?.();
  if(!p)return null;
  const source=new Set(p.sourceIds),native=new Set(p.nativeIds),mesh=new Set(p.meshIds),overlap=[...native].filter(id=>mesh.has(id)),missing=[...source].filter(id=>!native.has(id)&&!mesh.has(id));
  const signalSnapshot=el.readGameSignalProbe?.(),nodes=signalSnapshot?.junctions??[],nodeIds=nodes.map(node=>node.id),approachIds=nodes.flatMap(node=>node.approaches.map(approach=>`${node.id}:${approach.id}`));
  return {camera:p.camera,bounds:p.bounds,sourceBounds:p.sourceBounds,source:p.sourceIds.length,native:p.nativeIds.length,mesh:p.meshIds.length,
    meshInSource:[...mesh].filter(id=>source.has(id)).length,overlap:overlap.slice(0,10),missing:missing.slice(0,10),
    state:p.diagnostics.state,visible:p.diagnostics.visible,loading:p.diagnostics.loading,triangles:p.diagnostics.triangles,renderedVisibleTiles:p.diagnostics.renderedVisibleTiles,
    cacheBytes:p.diagnostics.cacheBytes,flows:p.diagnostics.aggregateFlowSegments,renderedFlows:p.diagnostics.renderedAggregateFlowSegments,
    flowOpacity:p.diagnostics.aggregateFlowOpacity,actorsState:p.diagnostics.actorsState,actorsVisible:p.diagnostics.actorsVisible,
    frame:Number(el.dataset.gameFrames??0),people:Number(el.dataset.deckPedestrians??0),vehicles:Number(el.dataset.deckVehicles??0),
    mapMode:el.dataset.gameMapMode,bankState:p.banks?.state,bankPending:p.banks?.pending,bankGeneration:p.banks?.generation,
    error:p.diagnostics.error,canvasCount:document.querySelectorAll('canvas').length,overlay:Boolean(document.querySelector('vite-error-overlay,#webpack-dev-server-client-overlay')),
    catalog:JSON.parse(el.dataset.gameCatalog??'null'),textures:JSON.parse(el.dataset.gameTextures??'null'),memory:JSON.parse(el.dataset.gameMemory??'null'),
    signalRenderer:JSON.parse(el.dataset.gameSignals??'null'),
    signalControllerOverflow:signalSnapshot?.diagnostics?.overflow??0,
    duplicateSignalIds:nodeIds.length-new Set(nodeIds).size+approachIds.length-new Set(approachIds).size};
};
async function sample(page,label,{expectedPackageError=false}={}){const value=await page.evaluate(compact);if(value){report.samples.push({label,elapsedMs:Date.now()-start,...value});
  assert(value.overlap.length===0&&value.missing.length===0&&value.native+value.meshInSource===value.source,`${label}: canonical partition`,{source:value.source,native:value.native,meshInSource:value.meshInSource});
  if(value.camera.zoom>=15.5)assert(value.renderedFlows===0&&value.flowOpacity===0,`${label}: no close aggregate flows`,{retainedFlows:value.flows,renderedFlows:value.renderedFlows,opacity:value.flowOpacity,zoom:value.camera.zoom});
  assert(!['disposed','context_lost',...(expectedPackageError?[]:['error'])].includes(value.state),`${label}: renderer remains active`,{state:value.state,error:value.error,expectedPackageError});
  assert(!value.overlay&&value.canvasCount===1,`${label}: one healthy canvas`);
  assert(value.duplicateSignalIds===0,`${label}: unique signal identities`);
  assert(value.signalControllerOverflow===0,`${label}: bounded traffic topology`,{overflow:value.signalControllerOverflow});
  assert(Boolean(value.signalRenderer)&&!['error_hidden','disposed'].includes(value.signalRenderer?.state),`${label}: signal props remain healthy`,{state:value.signalRenderer?.state??'diagnostic_missing',error:value.signalRenderer?.lastError});
  if(value.memory?.geometry){const geometry=value.memory.geometry;
    assert(geometry.committedBytes<=192*1024**2&&geometry.staging<=2,`${label}: bounded committed geometry and staging`,{committedBytes:geometry.committedBytes,staging:geometry.staging,stagingBytes:geometry.stagingBytes});}
  if(value.mapMode==='canonical_city'&&!value.bankPending)assert(value.source>0&&(value.native>0||value.mesh>0&&value.triangles>0),`${label}: building representation`,{source:value.source,native:value.native,mesh:value.mesh,triangles:value.triangles});
  }return value;}
async function shot(page,label){const path=join(artifactRoot,label+'.png');await page.screenshot({path,timeout:8000});report.screenshots.push(path);}
async function ready(page,timeout=20000){if(remaining()<1000)throw new Error('QA wall-clock budget exhausted');await page.waitForFunction(()=>typeof document.querySelector('[data-testid="world-canvas"]')?.readGameOwnershipProbe==='function',null,{timeout:Math.min(timeout,remaining())});}
async function settle(page,label,timeout=6500){
  if(remaining()<1000)return false;
  try{await page.waitForFunction(()=>{const p=document.querySelector('[data-testid="world-canvas"]')?.readGameOwnershipProbe?.();return p&&p.sourceIds.length>0
    &&p.banks?.state==='canonical'&&!p.banks?.pending&&p.diagnostics.state==='rendering'&&p.meshIds.length>0&&p.diagnostics.renderedVisibleTiles>0;},null,{timeout:Math.min(timeout,remaining())});return true;}
  catch{assert(false,`${label}: settled detailed frontier`,{timeoutMs:timeout});return false;}
}
async function camera(page,pose,zoom,dwell=120){
  if(remaining()<1000)throw new Error('QA wall-clock budget exhausted');
  await page.evaluate(value=>{location.hash=value;},hash(pose,zoom));
  await page.waitForFunction(({lon,lat,zoom})=>{const p=document.querySelector('[data-testid="world-canvas"]')?.readGameOwnershipProbe?.();return p&&Math.abs(p.camera.longitude-lon)<.00002&&Math.abs(p.camera.latitude-lat)<.00002&&Math.abs(p.camera.zoom-zoom)<.005;},
    {lon:pose.lon,lat:pose.lat,zoom},{timeout:Math.min(2500,remaining())});
  await page.waitForTimeout(Math.min(dwell,remaining()));
}
async function context(name,video=false){
  const ctx=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1,locale:'ru-RU',timezoneId:'Europe/Moscow',
    ...(video?{recordVideo:{dir:artifactRoot,size:{width:960,height:600}}}:{})});
  const page=await ctx.newPage();report.contexts.push(name);
  page.on('pageerror',e=>report.errors.push({context:name,message:e.message}));
  page.on('console',m=>{if(['error','warning'].includes(m.type())&&report.console.length<150)report.console.push({context:name,type:m.type(),text:m.text().slice(0,1500)});});
  page.on('response',r=>{if(r.status()>=400&&report.network.length<100)report.network.push({context:name,status:r.status(),url:r.url()});});
  return {ctx,page};
}
try{
  // Do not inspect a stale quarter while the parent task atomically activates the catalog.
  while(true){const manifest=await fetch(target+'city-visual-v1/manifest.json').then(r=>r.json());if(manifest.visualCatalog?.sha256===expectedCatalog)break;
    if(remaining()<240000)throw new Error('Expected full-city preview catalog was not activated within bounded preflight');await new Promise(r=>setTimeout(r,1000));}
  browser=await chromium.launch({headless:true,...(browserChannel==='chromium'?{}:{channel:browserChannel})});
  report.browserChannel=browserChannel;
  const main=await context('warm-camera-sweeps',true),page=main.page;
  await page.goto(target+hash(poses[0],16.86436467681756),{waitUntil:'domcontentloaded',timeout:25000});await ready(page,35000);
  await page.waitForTimeout(2500);await sample(page,'cold-user');await shot(page,'01-cold-user');
  await settle(page,'warm-user',10000);await sample(page,'warm-user');await shot(page,'02-warm-user');
  assert((await page.title()).length>0,'page identity',{url:page.url(),title:await page.title()});
  assert((await page.locator('body').innerText()).length>100,'meaningful app content');
  const up=Array.from({length:25},(_,i)=>14+i*.25),down=up.toReversed();
  for(const pose of poses){
    if(remaining()<75000){report.limitations.push('Remaining camera sweeps skipped to reserve fault/recovery budget');break;}
    let completed=0;
    for(const direction of [up,down])for(const zoom of direction){
      if(remaining()<75000)break;
      try{await camera(page,pose,zoom);await sample(page,`${pose.name}-${direction===up?'up':'down'}-${zoom}`);completed++;report.coverage.completedZoomSamples++;}
      catch(error){report.errors.push({stage:pose.name,zoom,message:error.message});break;}
    }
    await camera(page,pose,17,350);await settle(page,pose.name,4500);await sample(page,`${pose.name}-settled`);await shot(page,`sweep-${pose.name}`);
    console.log(JSON.stringify({stage:'sweep',pose:pose.name,completed,remainingMs:remaining(),failures:report.checks.filter(c=>!c.pass).length}));
  }
  if(remaining()>60000){
    await camera(page,poses[0],17,500);const box=await page.locator('canvas').boundingBox();
    await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);
    for(let i=0;i<8;i++){await page.mouse.wheel(0,i<4?-160:160);await page.waitForTimeout(90);await sample(page,`continuous-wheel-${i}`);}
    await page.mouse.down({button:'right'});await page.mouse.move(box.x+box.width*.5+100,box.y+box.height*.5-45,{steps:18});await page.mouse.up({button:'right'});
    await page.mouse.down();await page.mouse.move(box.x+box.width*.5+180,box.y+box.height*.5+60,{steps:18});await page.mouse.up();await page.waitForTimeout(700);
    await sample(page,'continuous-rotation-pan');await shot(page,'09-after-continuous-motion');
    for(const [district,lon,lat] of districtProbes){if(remaining()<55000)break;
      await camera(page,{...poses[1],lon,lat},17.5,500);await settle(page,`district-${district}`,5500);await sample(page,`district-${district}`);report.coverage.completedDistricts.push(district);}
    await camera(page,poses[0],18.2,1800);await settle(page,'cache-return');await sample(page,'cache-return');await shot(page,'10-user-close-return');
    const restoration=await page.evaluate(async()=>{const canvas=document.querySelector('canvas'),gl=canvas?.getContext('webgl2')??canvas?.getContext('webgl'),ext=gl?.getExtension('WEBGL_lose_context');
      if(!ext)return{available:false};ext.loseContext();await new Promise(r=>setTimeout(r,600));ext.restoreContext();return{available:true};});
    await page.waitForTimeout(1800);await settle(page,'webgl-restored',8000);const recovered=await sample(page,'webgl-restored');
    assert(!restoration.available||recovered?.state==='rendering'&&recovered.mesh>0&&recovered.actorsVisible,'WebGL restoration',{restoration,state:recovered?.state,mesh:recovered?.mesh,actorsVisible:recovered?.actorsVisible});
    await shot(page,'11-webgl-restored');
  }
  await main.ctx.close();
  for(const fault of ['missing-top-manifest','corrupted-top-manifest','delayed-glb','corrupted-glb','native-source-failure']){
    if(remaining()<15000){report.limitations.push(`Fault scenario skipped by wall-clock budget: ${fault}`);break;}
    const {ctx,page}=await context(fault);let injected=0;
    if(fault.endsWith('top-manifest'))await page.route('**/city-visual-v1/manifest.json',route=>{injected++;return route.fulfill({status:fault.startsWith('missing')?503:200,contentType:'application/json',body:'{"contract":"unavailable"}'});});
    else if(fault==='native-source-failure')await page.route('**/city-v2/**/cells/**',route=>{injected++;return route.abort('failed');});
    else await page.route('**/city-visual-v1/**/tiles/near-*.glb',async route=>{
      if(injected){await route.continue();return;}injected++;
      if(fault==='delayed-glb'){await new Promise(r=>setTimeout(r,3500));await route.continue();}
      else{const response=await route.fetch(),body=await response.body();body[body.length-1]^=1;await route.fulfill({response,body});}
    });
    try{await page.goto(target+hash(poses[0],18.2),{waitUntil:'domcontentloaded',timeout:Math.min(12000,remaining())});await ready(page,12000);
      const expectedPackageError=fault.endsWith('top-manifest');
      await page.waitForTimeout(Math.min(2200,remaining()));await sample(page,`${fault}-during`,{expectedPackageError});await shot(page,`${fault}-during`);
      await page.waitForTimeout(Math.min(2500,remaining()));
      if(fault.endsWith('top-manifest')&&remaining()>2000)await page.waitForFunction(()=>{const el=document.querySelector('[data-testid="world-canvas"]');return Number(el?.getAttribute('data-deck-pedestrians'))>0&&Number(el?.getAttribute('data-deck-vehicles'))>0;},null,{timeout:Math.min(8000,remaining())}).catch(()=>{});
      const after=await sample(page,`${fault}-after`,{expectedPackageError});assert(injected>0,`${fault}: route exercised`,{injected});
      assert(after&&after.frame>0&&!['disposed','context_lost',...(expectedPackageError?[]:['error'])].includes(after.state),`${fault}: render survives`,{state:after?.state,frame:after?.frame});
      if(expectedPackageError){assert(after?.state==='error'&&Boolean(after.error),`${fault}: explicit degraded package`,{state:after?.state,error:after?.error});
        assert(after?.people>0&&after?.vehicles>0&&after?.actorsVisible&&after?.actorsState==='ready',`${fault}: independent actors survive`,{people:after?.people,vehicles:after?.vehicles,actorsVisible:after?.actorsVisible,actorsState:after?.actorsState});}
      report.coverage.completedFaults.push(fault);
    }catch(error){report.errors.push({stage:fault,message:error.message});}
    await ctx.close();
  }
}catch(error){report.errors.push({stage:'runner',message:error.message});}
finally{
  await browser?.close();report.sourceSha256After=await sourceFingerprint();
  assert(report.sourceSha256Before===report.sourceSha256After,'runtime source remained frozen',{before:report.sourceSha256Before,after:report.sourceSha256After});
  assert(report.coverage.completedZoomSamples===report.coverage.plannedZoomSamples,'all 300 zoom samples completed',{completed:report.coverage.completedZoomSamples});
  assert(report.coverage.completedDistricts.length===report.coverage.plannedDistricts,'all seven district probes completed',{completed:report.coverage.completedDistricts});
  assert(report.coverage.completedFaults.length===report.coverage.plannedFaults,'all five fault scenarios completed',{completed:report.coverage.completedFaults});
  report.elapsedMs=Date.now()-start;report.failedChecks=report.checks.filter(c=>!c.pass);
  report.status=report.errors.length||report.failedChecks.length?'findings':'passed_with_declared_limits';
  await writeFile(join(artifactRoot,'results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({artifactRoot,status:report.status,samples:report.samples.length,checks:report.checks.length,failedChecks:report.failedChecks.length,errors:report.errors,elapsedMs:report.elapsedMs}));
  process.exitCode=report.status==='findings'?1:0;
}
