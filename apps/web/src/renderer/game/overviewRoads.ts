import type { Feature } from 'geojson';
import type { CityRoad } from '../../demo/cityRoadGraph';
import { hashSeed } from '../rng';
const drive=new Set(['motorway','trunk','primary','secondary','tertiary','minor','service','residential','living_street']);
/** Decode only currently loaded, source-backed road lines; no synthetic people or network extension. */
export function overviewRoads(features:readonly Feature[]):CityRoad[] {
  const output:CityRoad[]=[],seen=new Set<string>();let vertices=0;
  for(const feature of features.slice(0,20000)){
    const kind=String(feature.properties?.class??feature.properties?.highway??'');if(!drive.has(kind))continue;
    const geometry=feature.geometry;
    const lines=geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:[];
    for(const line of lines){
      if(line.length<2||line.length>2048||vertices+line.length>200000)continue;
      if(!line.every(p=>p.length>=2&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&Math.abs(p[0]!)<=180&&Math.abs(p[1]!)<85))continue;
      vertices+=line.length;
      const coordinates=line.map(p=>[p[0]!,p[1]!] as const);
      const id=`source-flow:${feature.id??''}:${hashSeed(JSON.stringify(coordinates))}`;
      if(seen.has(id))continue;seen.add(id);
      const direction=feature.properties?.oneway;
      output.push({id,coordinates,className:kind,drivable:true,walkable:false,oneway:direction===-1?-1:direction===1||direction==='yes'?1:0});
      if(output.length>=10000)return output;
    }
  }
  return output;
}
