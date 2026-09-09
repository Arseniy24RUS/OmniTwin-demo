import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CityDemoProviderV2 } from './CityDemoProviderV2';
import type { DemoContextV1 } from '../types';

const spatialPath = new URL('../../../public/demo-v2/spatial/manifest.json', import.meta.url);
const available = existsSync(spatialPath) && Boolean(JSON.parse(readFileSync(spatialPath, 'utf8')).movementIndex);
afterEach(() => vi.unstubAllGlobals());

it.runIf(available)('real movement index supplies unique canonical near actors with explicit bounded coverage', async () => {
  vi.stubGlobal('fetch', async (input:RequestInfo|URL, options?:RequestInit) => {
    options?.signal?.throwIfAborted(); const url=new URL(String(input));
    if(url.origin!=='https://movement.fixture.test'||url.pathname.includes('..'))throw new Error('Unexpected fixture request');
    try { const bytes=await readFile(new URL(`../../../public${url.pathname}`,import.meta.url)); return new Response(bytes,{status:200,headers:{'Content-Type':url.pathname.endsWith('.gz')?'application/gzip':'application/octet-stream'}}); }
    catch { return new Response('',{status:404}); }
  });
  const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
  const provider=await CityDemoProviderV2.loadCity('https://movement.fixture.test/',undefined,{populationManifestSha256:sha(await readFile(new URL('../../../public/demo-v2/manifest.json',import.meta.url))),spatialManifestSha256:sha(await readFile(spatialPath))});
  const evidence:object[]=[];
  for(const [name,longitude,latitude] of [['center',61.4026,55.1644],['north-west',61.28255735,55.21110955]] as const)for(const minutes of [690,1100]){
    const context:DemoContextV1={datasetId:provider.manifest.datasetId,scenario:'baseline',year:2026,territoryId:'RU-CHE-SET',cohort:null,presentationMinutes:minutes,weather:'clear',playing:false,speed:1,camera:{longitude,latitude,zoom:17.4,pitch:55,bearing:0}};
    const bbox=[longitude-.004,latitude-.002,longitude+.004,latitude+.002] as const;
    const start=performance.now();await provider.prepareViewport(context,undefined,{camera:context.camera,bbox,widthCss:1920,heightCss:1080,revision:`${name}-${minutes}`});
    const profiles=provider.getVisibleCandidates('baseline',2026,5000,{longitude,latitude,radiusMeters:2500,minutes});
    const presences=profiles.map(profile=>provider.getPresence(profile.id,minutes,'baseline',2026)!);
    const entityIds=presences.map(p=>p.vehicleId??p.personId),roads=new Set(presences.map(p=>p.roadId));
    expect(provider.movementCoverage.mode).toBe('activity_index');expect(['ready','partial']).toContain(provider.movementCoverage.status);
    expect(profiles.length).toBeGreaterThan(0);expect(new Set(profiles.map(p=>p.id)).size).toBe(profiles.length);expect(new Set(entityIds).size).toBe(entityIds.length);
    expect(provider.movementCoverage.decodedBytes).toBeLessThanOrEqual(24*1024*1024);expect(provider.movementCoverage.networkBytes).toBeLessThanOrEqual(12*1024*1024);expect(provider.movementCoverage.recordsScanned).toBeLessThanOrEqual(131072);
    for(const presence of presences){expect(['vehicle','outdoor']).toContain(presence.state);expect(presence.position![0]).toBeGreaterThanOrEqual(bbox[0]);expect(presence.position![0]).toBeLessThanOrEqual(bbox[2]);expect(presence.position![1]).toBeGreaterThanOrEqual(bbox[1]);expect(presence.position![1]).toBeLessThanOrEqual(bbox[3]);}
    evidence.push({name,minutes,actors:profiles.length,people:presences.filter(p=>p.state==='outdoor').length,vehicles:presences.filter(p=>p.state==='vehicle').length,roads:roads.size,elapsedMs:Math.round(performance.now()-start),coverage:provider.movementCoverage});
  }
  expect(provider.manifest.initialPopulation).toBe(1177058);
  // Inspectable counts from local pinned artifacts, not a browser/FPS claim.
  process.stdout.write(`Bounded movement-index evidence: ${JSON.stringify(evidence)}\n`);
},60000);
