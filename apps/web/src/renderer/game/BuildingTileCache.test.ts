import {describe,it,expect} from 'vitest';
import {BuildingCacheAdmission} from './buildingCacheAdmission';
import {BuildingTileCache} from './BuildingTileCache';
describe('building geometry admission through the public tile cache',()=>{
  it('allows two staging tiles beside a full committed frontier and never reloads an excluded tile in the same epoch',()=>{
    const admission=new BuildingCacheAdmission({maxBytes:100,maxStaging:2});
    const cache=new BuildingTileCache(admission,8),a={content:{uri:'a.glb'}},b={content:{uri:'b.glb'}},c={content:{uri:'c.glb'}},d={content:{uri:'d.glb'}};
    expect(cache.add(a,()=>admission.release('a.glb'))).toBe(true);admission.loaded('a.glb',100);cache.setMemoryUsage(a,100);
    admission.reconcile(['a.glb'],['a.glb'],'camera');
    expect(cache.add(b,()=>{})).toBe(true);expect(cache.add(c,()=>{})).toBe(true);expect(cache.add(d,()=>{})).toBe(false);
    admission.loaded('b.glb',60);admission.loaded('c.glb',50);
    expect(admission.reconcile(['a.glb'],['b.glb'],'camera')).toEqual(['c.glb']);cache.remove(c);
    expect(cache.add(c,()=>{})).toBe(false);
    expect(admission.reconcile(['b.glb'],['b.glb'],'camera')).toEqual(['a.glb']);cache.remove(a);
    expect(admission.diagnostics).toMatchObject({residentBytes:60,staging:0});
    expect(cache.add(d,()=>{})).toBe(true);
  });
  it('bounds metadata separately and releases cancelled reservations without dropping committed geometry',()=>{
    const admission=new BuildingCacheAdmission({maxBytes:100,maxStaging:2}),cache=new BuildingTileCache(admission,1);
    const root={content:{uri:'cell.json'}},next={content:{uri:'next.json'}},a={content:{uri:'a.glb'}};
    expect(cache.add(root,()=>{})).toBe(true);expect(cache.add(next,()=>{})).toBe(false);
    expect(cache.add(a,()=>{})).toBe(true);expect(admission.diagnostics.pending).toBe(1);
    cache.remove(a);expect(admission.diagnostics.pending).toBe(0);
    cache.remove(root);expect(cache.add(next,()=>{})).toBe(true);
    expect(cache.isFull()).toBe(false);
  });
  it('does not repeatedly cancel USED pending staging beside a saturated parent and parsed child',()=>{
    const admission=new BuildingCacheAdmission({maxBytes:100,maxStaging:2}),cache=new BuildingTileCache(admission,8);
    cache.maxBytesSize=100;cache.minBytesSize=70;cache.maxSize=8;cache.minSize=5;
    const parent={content:{uri:'parent.glb'}},parsed={content:{uri:'parsed.glb'}},pending={content:{uri:'pending.glb'}};
    const removed:string[]=[];
    cache.add(parent,()=>removed.push('parent'));admission.loaded('parent.glb',100);cache.setMemoryUsage(parent,100);cache.setLoaded(parent,true);
    admission.reconcile(['parent.glb'],['parent.glb'],'view');
    cache.add(parsed,()=>removed.push('parsed'));admission.loaded('parsed.glb',60);cache.setMemoryUsage(parsed,60);cache.setLoaded(parsed,true);
    cache.add(pending,()=>removed.push('pending'));cache.setMemoryUsage(pending,0);cache.setLoaded(pending,false);
    admission.reconcile(['parent.glb'],['parsed.glb'],'view');
    for(let frame=0;frame<30;frame++){
      for(const tile of [parent,parsed,pending])cache.markUsed(tile);
      cache.unloadUnusedContent();
      expect(cache.has(pending)).toBe(true);expect(cache.has(parent)).toBe(true);
    }
    expect(removed).toEqual([]);expect(admission.diagnostics).toMatchObject({committedBytes:100,staging:2,pending:1});
    for(const key of admission.reconcile(['parsed.glb'],['parsed.glb'],'view'))if(key==='parent.glb')cache.remove(parent);
    expect(removed).toEqual(['parent']);expect(admission.diagnostics.committedBytes).toBe(60);
    cache.remove(pending);expect(admission.diagnostics.staging).toBe(0);
  });
  it('retains metadata ancestors of reserved or committed GLBs even when traversal marks them unused',()=>{
    const admission=new BuildingCacheAdmission({maxBytes:100,maxStaging:2}),cache=new BuildingTileCache(admission,2);
    cache.minSize=0;cache.maxSize=2;cache.minBytesSize=0;cache.maxBytesSize=100;
    const root={content:{uri:'root.json'}},cold={content:{uri:'cold.json'}},pending={content:{uri:'child.glb'},parent:root};
    const removed:string[]=[];cache.add(root,()=>removed.push('root'));cache.add(cold,()=>removed.push('cold'));cache.add(pending,()=>removed.push('pending'));
    cache.markAllUnused();cache.unloadUnusedContent();
    expect(cache.has(root)).toBe(true);expect(cache.has(pending)).toBe(true);expect(cache.has(cold)).toBe(false);
    expect(removed).toEqual(['cold']);
  });
});
