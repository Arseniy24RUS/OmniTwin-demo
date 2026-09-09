import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (a,b) => a < b ? -1 : a > b ? 1 : 0;
export function tileBounds(z,x,y) {
  const n=2**z, longitude=v=>v/n*360-180, latitude=v=>Math.atan(Math.sinh(Math.PI*(1-2*v/n)))*180/Math.PI;
  return [longitude(x),latitude(y+1),longitude(x+1),latitude(y)];
}
export function ownerCellKey(center,zoom=15) {
  if (!Array.isArray(center)||center.length!==2||!center.every(Number.isFinite)||Math.abs(center[0])>180||Math.abs(center[1])>85) throw new Error('Invalid building ownership center');
  const n=2**zoom,x=Math.min(n-1,Math.floor((center[0]+180)/360*n)),y=Math.floor((1-Math.asinh(Math.tan(center[1]*Math.PI/180))/Math.PI)/2*n);
  return `z${zoom}-x${x}-y${y}`;
}
/** Sparse z15 parent jobs: no whole-city geometry read and no arbitrary missing-cell inference. */
export function planCatalogJobs(manifest,{partitionZoom=15}={}) {
  if (manifest.contract!=='DemoCityPackManifestV2'||manifest.cellZoom!==16||!Array.isArray(manifest.cells)
    ||![15,16].includes(partitionZoom)||manifest.cells.length>20_000) throw new Error('Unsupported city source partition');
  const jobs=new Map(),seen=new Set(),divisor=2**(16-partitionZoom);
  for (const descriptor of manifest.cells) {
    if (!/^16\/\d+\/\d+$/.test(descriptor.key)||seen.has(descriptor.key)) throw new Error('Invalid or duplicate source cell');
    seen.add(descriptor.key);
    if (!Number.isSafeInteger(descriptor.bytes)||descriptor.bytes<1||descriptor.bytes>4*1024*1024
      ||!Number.isSafeInteger(descriptor.buildingCount)||descriptor.buildingCount<0) throw new Error('Source cell exceeds bounded byte/count budget');
    const [,sx,sy]=descriptor.key.split('/').map(Number),x=Math.floor(sx/divisor),y=Math.floor(sy/divisor);
    if(sx<0||sy<0||sx>=65536||sy>=65536)throw new Error('Source cell coordinate invalid');
    const expected=tileBounds(16,sx,sy);
    if(!Array.isArray(descriptor.bbox)||descriptor.bbox.length!==4||!descriptor.bbox.every((v,i)=>Number.isFinite(v)&&Math.abs(v-expected[i])<1e-9))throw new Error('Source cell bounds disagree with grid');
    const key=`z${partitionZoom}-x${x}-y${y}`;
    const job=jobs.get(key)??{key,partitionZoom,x,y,bounds:tileBounds(partitionZoom,x,y),sourceCells:[],sourceBytes:0,sourceBuildingRows:0};
    job.sourceCells.push(descriptor);job.sourceBytes+=descriptor.bytes;job.sourceBuildingRows+=descriptor.buildingCount;jobs.set(key,job);
  }
  return [...jobs.values()].sort((a,b)=>compare(a.key,b.key)).map(job=>({...job,sourceCells:job.sourceCells.sort((a,b)=>compare(a.key,b.key))}));
}

/** Whole source footprints are retained. Shared border copies must agree exactly. */
export function ownedBuildings(job,cells) {
  const found=new Map();
  for (const cell of cells) for (const building of cell.buildings) {
    if (!/^openmaptiles_buildings:[1-9]\d{0,19}$/.test(building.id)||!(building.heightM>0)||!Number.isFinite(building.heightM)) throw new Error('Invalid source building identity/height');
    const hash=sha256(JSON.stringify(building)),previous=found.get(building.id);
    if(previous&&previous.hash!==hash)throw new Error('Conflicting source copies of a canonical building');
    found.set(building.id,{hash,building});
  }
  const owned=[...found.values()].map(v=>v.building).filter(b=>ownerCellKey(b.center,job.partitionZoom)===job.key).sort((a,b)=>compare(a.id,b.id));
  if(owned.length>1500)throw new Error('Owned building count exceeds per-cell admission budget');
  return owned;
}

export function unionBounds(bounds) {
  return [Math.min(...bounds.map(b=>b[0])),Math.min(...bounds.map(b=>b[1])),Math.max(...bounds.map(b=>b[2])),Math.max(...bounds.map(b=>b[3]))];
}

/** Conservative ECEF AABB from all eight corners of the compiled metre-space root. */
export function catalogRootBoundingVolume(root) {
  const box=root.boundingVolume?.box,m=root.transform;
  if(!Array.isArray(box)||box.length!==12||!Array.isArray(m)||m.length!==16||![...box,...m].every(Number.isFinite))throw new Error('Invalid compiled root bounding frame');
  const points=[];
  for(const a of[-1,1])for(const b of[-1,1])for(const c of[-1,1]){
    const p=[0,1,2].map(i=>box[i]+a*box[3+i]+b*box[6+i]+c*box[9+i]);
    points.push([0,1,2].map(i=>m[i]*p[0]+m[4+i]*p[1]+m[8+i]*p[2]+m[12+i]));
  }
  const min=[0,1,2].map(i=>Math.min(...points.map(p=>p[i]))),max=[0,1,2].map(i=>Math.max(...points.map(p=>p[i])));
  return {box:[...min.map((v,i)=>(v+max[i])/2),(max[0]-min[0])/2,0,0,0,(max[1]-min[1])/2,0,0,0,(max[2]-min[2])/2]};
}
