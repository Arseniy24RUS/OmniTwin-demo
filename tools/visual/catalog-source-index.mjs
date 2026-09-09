import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { ownerCellKey, sha256 } from './catalog-planner.mjs';

/** The small canonical index establishes local ownership without reading citywide geometry. */
export async function readCatalogOwnershipIndex(sourceRoot, source, jobs) {
  const descriptor=source.buildingIndex;
  if(!descriptor||!Number.isSafeInteger(descriptor.bytes)||descriptor.bytes<1||descriptor.bytes>24*1024*1024
    ||!Number.isSafeInteger(descriptor.count)||descriptor.count<0||descriptor.count>200_000
    ||typeof descriptor.url!=='string'||!/^[-a-zA-Z0-9_./]+$/.test(descriptor.url)
    ||descriptor.url.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid canonical source index descriptor');
  const path=resolve(sourceRoot,descriptor.url),part=relative(resolve(sourceRoot),path);
  if(!part||part==='..'||part.startsWith(`..${sep}`)||isAbsolute(part))throw new Error('Canonical source index escaped source root');
  const bytes=await readFile(path);
  if(bytes.length!==descriptor.bytes||sha256(bytes)!==descriptor.sha256)throw new Error('Canonical source index integrity failure');
  const index=JSON.parse(bytes),positions=['id','lon','lat','districtId'].map(name=>index.columns?.indexOf(name));
  if(index.contract!=='DemoBuildingIndexV2'||positions.some(p=>p===undefined||p<0)||!Array.isArray(index.rows)
    ||index.rows.length!==descriptor.count||index.rows.length!==source.coverage?.buildings)throw new Error('Canonical source index completeness mismatch');
  const owners=new Map(jobs.map(job=>[job.key,{ids:[],districtCounts:{}}])),districts=new Map(),seen=new Set();
  for(const row of index.rows){
    const [id,lon,lat,district]=positions.map(p=>row[p]);
    if(typeof id!=='string'||!/^openmaptiles_buildings:[1-9]\d{0,19}$/.test(id)||seen.has(id))throw new Error('Duplicate or invalid canonical index identity');
    seen.add(id);const key=ownerCellKey([lon,lat],jobs[0]?.partitionZoom??15),owner=owners.get(key);
    if(!owner)throw new Error('Canonical index ownership has no planned source job');
    const districtId=typeof district==='string'&&district?district:'unresolved';
    owner.ids.push(id);owner.districtCounts[districtId]=(owner.districtCounts[districtId]??0)+1;
    const summary=districts.get(districtId)??{count:0,longitude:0,latitude:0};
    summary.count++;summary.longitude+=lon;summary.latitude+=lat;districts.set(districtId,summary);
  }
  for(const owner of owners.values())owner.ids.sort();
  return {owners,districts,uniqueBuildings:seen.size,sourceIndexSha256:descriptor.sha256,sourceIndexBytes:bytes.length};
}

export function assertCatalogOwnership(index, job, buildings) {
  if(JSON.stringify(index.owners.get(job.key)?.ids)!==JSON.stringify(buildings.map(building=>building.id)))throw new Error('Source cell does not match canonical index ownership');
}

/** Reproducible urban probes, not a random or statistically representative sample. */
export function selectDistrictSampleJobs(index,jobs,districtIds,{minimumBuildings=40,maximumBuildings=350}={}) {
  const selected=new Set();
  return districtIds.map(districtId=>{
    const summary=index.districts.get(districtId);if(!summary)throw new Error('District absent from canonical index');
    const center=[summary.longitude/summary.count,summary.latitude/summary.count];
    const candidates=jobs.filter(job=>{
      const owner=index.owners.get(job.key),count=owner.ids.length,districtCount=owner.districtCounts[districtId]??0;
      return !selected.has(job.key)&&count>=minimumBuildings&&count<=maximumBuildings&&districtCount/count>=.75;
    }).map(job=>({job,distance:(((job.bounds[0]+job.bounds[2])/2-center[0])*Math.cos(center[1]*Math.PI/180))**2+((job.bounds[1]+job.bounds[3])/2-center[1])**2}));
    candidates.sort((a,b)=>a.distance-b.distance||a.job.key.localeCompare(b.job.key));
    if(!candidates.length)throw new Error('No bounded district sample satisfies declared selection');
    const job=candidates[0].job,owner=index.owners.get(job.key);selected.add(job.key);
    return {districtId,key:job.key,bounds:job.bounds,buildings:owner.ids.length,districtBuildings:owner.districtCounts[districtId],districtCounts:owner.districtCounts};
  });
}
