import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
const output=join(tmpdir(),`omnitwin-tree-provenance-${new Date().toISOString().replace(/[:.]/g,'-')}`);await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1280,height:800}});
await context.route('**/src/renderer/game/TiledGameLayer.ts*',async route=>{const response=await route.fetch(),body=await response.text(),pattern=/updateVegetation\(features,\s*options\)\s*\{/;if(!pattern.test(body))throw Error('Observed vegetation boundary missing');await route.fulfill({response,body:body.replace(pattern,match=>match+'globalThis.__qaTreeLayer=this;')});});
const page=await context.newPage(),errors=[],scenes=[];page.on('pageerror',error=>errors.push(error.message));
try{for(const pose of [{name:'MET',lon:61.40850385,lat:55.2572062,zoom:18.25,pitch:55,bearing:-35},{name:'CEN',lon:61.40335931261333,lat:55.166641128116765,zoom:18.2,pitch:46.49661799282392,bearing:-172.97699800600026}]){
const params=new URLSearchParams({scenario:'baseline',year:'2026',territory:'RU-CHE-SET',minutes:'707.7335833333341',paused:'1',speed:'1',weather:'clear',lon:String(pose.lon),lat:String(pose.lat),zoom:String(pose.zoom),pitch:String(pose.pitch),bearing:String(pose.bearing),stats:'observed',observedYear:'2024',dataset:'omnitwin-fictional-city-v2',graphics:'tiled_game'});
await page.goto('about:blank');await page.goto('http://127.0.0.1:5178/OmniTwin-demo/#/world?'+params,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>globalThis.__qaTreeLayer?.vegetation.telemetry.instances>0,null,{timeout:60000});await page.waitForTimeout(2000);
const scene=await page.evaluate(()=>{const v=globalThis.__qaTreeLayer.vegetation;return{telemetry:v.telemetry,placements:v.placements,meshes:v.object.children.map(m=>({name:m.name,count:m.count,vertices:m.geometry.getAttribute('position').count}))};});
await page.screenshot({path:join(output,pose.name+'-visible.png')});await page.evaluate(()=>{globalThis.__qaTreeLayer.vegetation.object.visible=false;globalThis.__qaTreeLayer.requestFrame();});await page.waitForTimeout(500);await page.screenshot({path:join(output,pose.name+'-runtime-hidden.png')});scenes.push({pose,...scene});
}}catch(error){errors.push(error.message);}finally{await context.close();await browser.close();}
await writeFile(join(output,'results.json'),JSON.stringify({errors,scenes},null,2));console.log(JSON.stringify({output,errors,scenes:scenes.map(s=>({...s,placements:undefined}))}));
