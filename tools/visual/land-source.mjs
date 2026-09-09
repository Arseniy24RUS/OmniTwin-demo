import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve,sep,join } from 'node:path';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
const intersects=(a,b)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
const sha=b=>createHash('sha256').update(b).digest('hex');
function tileBounds({z,x,y}){const n=2**z,lon=t=>t/n*360-180,lat=t=>Math.atan(Math.sinh(Math.PI*(1-2*t/n)))*180/Math.PI;return[lon(x),lat(y+1),lon(x+1),lat(y)];}
export function selectLandTiles(manifest,bounds){return manifest.tiles.filter(t=>t.z===14&&intersects(tileBounds(t),bounds));}
export function extractLandFeatures(tile,descriptor,version){const result=[];for(const [name,layer]of Object.entries(tile.layers)){
  if(!['landcover','landuse','park','water','waterway','poi','tree','trees'].includes(name))continue;
  for(let i=0;i<layer.length;i++){const f=layer.feature(i),p=f.properties??{},isTreePoint=f.type===1&&(['tree','trees'].includes(name)||[p.natural,p.class,p.subclass].includes('tree'));
    if(f.type!==3&&!isTreePoint)continue;if(f.type===3&&['poi','tree','trees'].includes(name))continue;
    const source=f.toGeoJSON(descriptor.x,descriptor.y,descriptor.z);result.push({type:'Feature',id:`omt-land:${version}:${descriptor.z}/${descriptor.x}/${descriptor.y}:${name}:${f.id??i}:${i}`,sourceLayer:name,properties:{...p},geometry:source.geometry,provenance:'source_geometry',sourceTile:`${descriptor.z}/${descriptor.x}/${descriptor.y}`});
  }}return result;}
export async function loadLandSources(root,bounds){const sourceRoot=join(root,'apps/web/public/city'),manifestBytes=await readFile(join(sourceRoot,'manifest.json')),manifest=JSON.parse(manifestBytes),tiles=selectLandTiles(manifest,bounds);if(tiles.length>9)throw new Error('Land source must remain a bounded quarter');let bytes=0;const features=[],inputs=[];
  for(const d of tiles){const path=resolve(sourceRoot,d.url);if(!path.startsWith(sourceRoot+sep)||d.bytes>2*1024*1024)throw new Error('Unsafe land descriptor');const data=await readFile(path);bytes+=data.length;if(bytes>8*1024*1024||data.length!==d.bytes||sha(data)!==d.sha256)throw new Error('Land tile hash/byte integrity failure');const tile=new VectorTile(new PbfReader(data));features.push(...extractLandFeatures(tile,d,manifest.datasetVersion));inputs.push({z:d.z,x:d.x,y:d.y,sha256:d.sha256,bytes:d.bytes});}
  if(features.length>25000)throw new Error('Land feature budget exceeded');
  return {features,source:{packId:manifest.packId,datasetVersion:manifest.datasetVersion,manifestSha256:sha(manifestBytes),tiles:inputs,bytes,attribution:manifest.attribution,licenses:manifest.licenses,vintagePolicy:'Bounded pinned OpenMapTiles land geometry; distinct vintage from city-v2 buildings, not a runtime identity join'}};
}
