import {LRUCache} from '3d-tiles-renderer/core';
import {BuildingCacheAdmission} from './buildingCacheAdmission';
type CacheTile={content?:{uri?:string};parent?:CacheTile|null};
export const buildingTileKey=(tile:CacheTile):string|null=>typeof tile.content?.uri==='string'&&/\.glb$/i.test(tile.content.uri)?tile.content.uri:null;

/** The library's byte cap is advisory and can discard a parsed child solely
 * because its parent fills the budget. Admission reserves GLBs before download;
 * metadata has a separate count cap. Public remove remains the disposal owner. */
export class BuildingTileCache extends LRUCache{
  private readonly metadata=new Set<CacheTile>();
  private readonly geometry=new Set<CacheTile>();
  constructor(readonly admission:BuildingCacheAdmission,private readonly maxMetadata:number){super();}
  override isFull():boolean{return false;}
  override add(tile:CacheTile,remove:(tile:CacheTile)=>void):boolean{
    if(this.has(tile))return false;
    const key=buildingTileKey(tile);
    if(key?!this.admission.admit(key):this.metadata.size>=this.maxMetadata)return false;
    const accepted=super.add(tile,item=>{
      if(key){this.admission.release(key);this.geometry.delete(item);}else this.metadata.delete(item);
      remove(item);
    });
    if(!accepted&&key)this.admission.release(key);
    if(accepted&&!key)this.metadata.add(tile);
    if(accepted&&key)this.geometry.add(tile);
    return accepted;
  }
  /** Geometry retirement belongs exclusively to the bank/frontier transaction.
   * Default LRU cleanup deliberately discards USED but not-yet-loaded entries
   * above its advisory byte limit. Calling it with a saturated parent therefore
   * cancels the reserved second child on every frame and creates reload churn.
   * Admission already bounds retained bytes and both pending/parsed staging
   * slots; preserve those allocations until explicit remove/cancel/commit.
   * Only unused, unreferenced metadata participates in advisory cleanup here.
   */
  override unloadUnusedContent():void{
    const required=new Set<CacheTile>();
    for(const tile of this.geometry){
      let parent=tile.parent,depth=0;
      while(parent&&!required.has(parent)&&depth++<256){required.add(parent);parent=parent.parent;}
    }
    const target=Math.min(Math.floor(this.maxMetadata*.7),Math.max(0,this.minSize));
    if(this.metadata.size<=target)return;
    const unused=[...this.metadata].filter(tile=>!this.isUsed(tile)&&!required.has(tile));
    // The public 0.5.2 callback takes two arguments; its bundled declaration still
    // carries the older one-argument type. Never inspect private LRU collections.
    const priority=this.unloadPriorityCallback as unknown as ((a:CacheTile,b:CacheTile)=>number)|null;
    if(priority)unused.sort((a,b)=>-priority(a,b));
    for(const tile of unused){if(this.metadata.size<=target)break;this.remove(tile);}
  }
}
