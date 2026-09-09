export interface BuildingFrontierTile {
  readonly key: string;
  readonly parentKey: string | null;
  readonly canonicalIds: readonly string[];
  readonly drawable: boolean;
}
export interface BuildingFrontier {
  readonly revision: string;
  readonly tileKeys: readonly string[];
  readonly canonicalIds: readonly string[];
}

/** Exact source ownership of the currently drawable replacement frontier.
 * Missing detail remains in the canonical coarse bank; empty refinement retains root. */
export function chooseBuildingFrontier(
  inventory: readonly BuildingFrontierTile[], visibleKeys: readonly string[], rootKey: string, canonicalNativeRemainder=false,
): BuildingFrontier {
  const entries = new Map(inventory.map(tile=>[tile.key,tile]));
  if(entries.size!==inventory.length)throw new Error('Duplicate building frontier tile key');
  const selected=new Set(visibleKeys.filter(key=>entries.get(key)?.drawable));
  if(!selected.size&&entries.get(rootKey)?.drawable)selected.add(rootKey);
  for(const key of selected){
    let parent=entries.get(key)?.parentKey;
    const seen=new Set([key]);
    while(parent){
      if(seen.has(parent))throw new Error('Cyclic building frontier');
      seen.add(parent);
      if(selected.has(parent)){
        if(canonicalNativeRemainder)selected.delete(parent);
        else{selected.delete(key);break;}
      }
      parent=entries.get(parent)?.parentKey;
    }
  }
  const owners=new Set<string>(),tileKeys=[...selected].sort();
  for(const key of tileKeys)for(const id of entries.get(key)!.canonicalIds){
    if(owners.has(id))throw new Error('Duplicate canonical building owner in frontier');
    owners.add(id);
  }
  const canonicalIds=[...owners].sort();
  return {revision:JSON.stringify(tileKeys),tileKeys,canonicalIds};
}

/** Unselected identities remain in the native canonical bank, so pressure lowers
 * detail without dropping buildings. Larger staging allocations are not pinned. */
export function fitBuildingFrontier(inventory:readonly BuildingFrontierTile[],candidate:BuildingFrontier,
  metrics:readonly {key:string;bytes:number;distance:number}[],budget:number):BuildingFrontier{
  if(!Number.isSafeInteger(budget)||budget<0)throw Error('Invalid building frontier memory budget');
  const wanted=new Set(candidate.tileKeys),selected:string[]=[];let bytes=0;
  for(const item of [...metrics].filter(item=>wanted.has(item.key)).sort((a,b)=>a.distance-b.distance||a.key.localeCompare(b.key))){
    if(!Number.isSafeInteger(item.bytes)||item.bytes<0)throw Error('Invalid building geometry memory estimate');
    if(bytes+item.bytes<=budget){selected.push(item.key);bytes+=item.bytes;}
  }
  return chooseBuildingFrontier(inventory,selected,'',true);
}
