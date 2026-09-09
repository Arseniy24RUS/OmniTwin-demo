import { readFile,writeFile,mkdir,copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname,resolve,join,sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const catalogUrl=new URL('./assets/polyhaven-materials-v1.json',import.meta.url);
export const FAMILY_SOURCES={
  panel:['plastered_wall_02',3,3],brick:['brick_wall_001',1.5,1.5],plaster:['plastered_wall_02',3,3],
  industrial:['corrugated_iron',3,3],civic:['plastered_wall_02',3,3],timber:['wood_planks_grey',2,2],neutral:['plastered_wall_02',3,3],
  bitumen:['asphalt_02',3,3],metal:['corrugated_iron',3,3],tile:['clay_roof_tiles',2,2],concrete:['plastered_wall_02',3,3],
  asphalt:['asphalt_02',3,3],paving:['concrete_floor_02',3,3],trim:['plastered_wall_02',2,2],
};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

export function jpegDimensions(bytes){
  if(bytes[0]!==255||bytes[1]!==216)throw new Error('Expected a JPEG material');
  let i=2;
  while(i+8<bytes.length){
    if(bytes[i++]!==255)continue;
    let marker=bytes[i++];while(marker===255)marker=bytes[i++];
    if(marker===217||marker===218)break;
    const length=bytes.readUInt16BE(i);
    if(length<2||i+length>bytes.length)throw new Error('Invalid JPEG segment');
    if([192,193,194].includes(marker))return {width:bytes.readUInt16BE(i+5),height:bytes.readUInt16BE(i+3)};
    i+=length;
  }
  throw new Error('JPEG dimensions unavailable');
}

/** Imports twenty-one unmodified CC0 images, never raster edits or live runtime API.
 * Source fingerprints are pinned in the versioned catalog, including color space.
 * `outputDir` is the pack root; every GLB lives one directory below it in tiles/. */
export async function prepareMaterialKit(outputDir,{cacheDir=join(root,'.cache/polyhaven-material-kit-v1'),fetcher=fetch}={}){
  const target=resolve(outputDir),cache=resolve(cacheDir),safeRoot=join(root,'.cache')+sep;
  if(!target.startsWith(safeRoot)||!cache.startsWith(safeRoot))throw new Error('Material kit outputs must stay inside repo .cache');
  const catalog=JSON.parse(await readFile(catalogUrl,'utf8'));
  if(catalog.length!==21||catalog.reduce((n,d)=>n+d.bytes,0)>32*1024*1024)throw new Error('Material catalog exceeds budget');
  await mkdir(cache,{recursive:true});await mkdir(join(target,'materials'),{recursive:true});
  const assets=[],bySource=new Map();
  for(const d of catalog){
    if(!/^https:\/\/dl\.polyhaven\.org\/file\/ph-assets\/Textures\/jpg\/1k\//.test(d.sourceUrl)||!/^\w+\.jpg$/.test(d.filename)||d.bytes>2*1024*1024||!/^[a-f0-9]{64}$/.test(d.sha256))throw new Error('Invalid pinned material source');
    const cached=join(cache,d.filename);let bytes;
    try{bytes=await readFile(cached);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!bytes){
      const response=await fetcher(d.sourceUrl,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(30000)});
      if(!response.ok||!response.body)throw new Error('Material download failed');
      const chunks=[];let size=0;
      for await(const part of response.body){size+=part.byteLength;if(size>d.bytes)throw new Error('Material download exceeds pinned length');chunks.push(Buffer.from(part));}
      bytes=Buffer.concat(chunks);
      if(bytes.length!==d.bytes||sha(bytes)!==d.sha256)throw new Error('Material download integrity mismatch');
      await writeFile(cached,bytes,{flag:'wx'});
    }
    if(bytes.length!==d.bytes||sha(bytes)!==d.sha256)throw new Error('Cached material integrity mismatch');
    const dimensions=jpegDimensions(bytes);
    if(Math.max(dimensions.width,dimensions.height)>2048||Math.min(dimensions.width,dimensions.height)<256)throw new Error('Material image dimensions outside budget');
    const filename=`${d.sourceId}-${d.role}-${d.sha256.slice(0,16)}.jpg`,uri=`materials/${filename}`;
    await copyFile(cached,join(target,uri));
    const asset={...d,...dimensions,uri,role:d.role,representation:'visual_synthesis',colorSpace:d.role==='baseColor'?'sRGB':'linear',encoding:'provider-authored-jpeg'};
    assets.push(asset);
    const source=bySource.get(d.sourceId)??{};source[d.role]=`../${uri}`;bySource.set(d.sourceId,source);
  }
  const materialTextures={};
  for(const [family,[sourceId,u,v]] of Object.entries(FAMILY_SOURCES)){
    const source=bySource.get(sourceId);
    materialTextures[family]={baseColorUri:source.baseColor,normalUri:source.normal,ormUri:source.orm,repeatMeters:[u,v],normalScale:['panel','plaster','neutral','trim'].includes(family)?.22:.45,sourceId,license:'CC0-1.0'};
  }
  // Glass is authored PBR, not a photograph of a window or a claimed source facade.
  const provenance={contract:'CityMaterialKitV1',version:1,representation:'visual_synthesis',license:'CC0-1.0',licenseUrl:'https://polyhaven.com/license',provider:'Poly Haven',providerUrl:'https://polyhaven.com',apiCredit:'Powered by Poly Haven',surfaceScale:'Explicit visual metre scale; not an observation of a real building',files:assets,materials:materialTextures};
  await writeFile(join(target,'materials','provenance.json'),JSON.stringify(provenance,null,2)+'\n');
  return {materialTextures,assets,provenance};
}
