import { describe, expect, it } from 'vitest';
import { BuildingCacheAdmission, buildingCacheCameraEpoch } from './buildingCacheAdmission';

describe('bounded building geometry retention and staging', () => {
  it('does not reject a newly parsed MET leaf from an older native-bank callback before frontier traversal reviews it',()=>{
    const cache=new BuildingCacheAdmission({maxBytes:192*1024**2,maxStaging:2});
    cache.admit('near-2-2');cache.loaded('near-2-2',1_367_136);cache.reconcile([],['near-2-2'],'MET');
    cache.admit('near-3-2');cache.loaded('near-3-2',684_288);
    // Real ordering: load-model -> prerender -> announceReady -> native bank
    // callback. The old candidate has not considered the just-parsed second leaf.
    expect(cache.reconcile([],['near-2-2'],'MET',{frontierReviewed:false})).toEqual([]);
    expect(cache.isProtected('near-3-2')).toBe(true);
    expect(cache.diagnostics).toMatchObject({staging:2,denied:0});
    expect(cache.admit('third')).toBe(false);
    cache.reconcile([],['near-2-2','near-3-2'],'MET');
    cache.reconcile(['near-2-2','near-3-2'],['near-2-2','near-3-2'],'MET',{frontierReviewed:false});
    expect(cache.diagnostics).toMatchObject({staging:0,denied:0,committedBytes:2_051_424});
  });
  it('rebases ready candidates when a native bank retires many committed tiles at once',()=>{
    const cache=new BuildingCacheAdmission({maxBytes:192,maxStaging:2});
    const keys=['a','b','c','d'];
    for(let i=0;i<keys.length;i++){cache.admit(keys[i]!);cache.loaded(keys[i]!,20);cache.reconcile(keys.slice(0,i+1),keys.slice(0,i+1),'view');}
    // The camera has left canonical coverage: the ready native bank owns all
    // buildings. Previous committed GLBs must not become four staging slots.
    const candidate=cache.rebaseCandidate([],keys);
    expect(candidate).toEqual(['a','b']);
    const retired=cache.reconcile([],candidate,'view');
    expect(retired).toEqual(['c','d']);retired.forEach(key=>cache.release(key));
    expect(cache.diagnostics.staging).toBe(2);
  });
  it('keeps pending downloads reserved while rebasing the previous committed frontier',()=>{
    const cache=new BuildingCacheAdmission({maxBytes:192,maxStaging:2});
    cache.admit('old');cache.loaded('old',100);cache.reconcile(['old'],['old'],'view');
    cache.admit('slow-a');cache.admit('slow-b');
    const candidate=cache.rebaseCandidate([],['old']);expect(candidate).toEqual([]);
    cache.reconcile([],candidate,'view').forEach(key=>cache.release(key));
    expect(cache.diagnostics).toMatchObject({staging:2,pending:2});
    expect(cache.isProtected('slow-a')).toBe(true);expect(cache.admit('third')).toBe(false);
  });
  const controller = () => new BuildingCacheAdmission({ maxBytes: 192, maxStaging: 2 });
  it('counts both pending and parsed staging, independently of zero-byte library estimates', () => {
    const cache = controller();
    expect(cache.admit('a')).toBe(true); expect(cache.admit('b')).toBe(true);
    expect(cache.admit('c')).toBe(false);
    expect(cache.loaded('a', 100)).toBe(true);
    expect(cache.admit('c')).toBe(false);
    expect(cache.reconcile([], ['a'], 'view')).toEqual([]);
    expect(cache.reconcile(['a'], ['a'], 'view')).toEqual([]);
    expect(cache.admit('c')).toBe(true);
  });
  it('retains the committed parent while a delayed child and native bank are pending', () => {
    const cache = controller(); cache.admit('parent'); cache.loaded('parent', 150);
    cache.reconcile(['parent'], ['parent'], 'view');
    cache.admit('child'); cache.loaded('child', 100);
    expect(cache.reconcile(['parent'], ['child'], 'view')).toEqual([]);
    expect(cache.diagnostics).toMatchObject({ committedBytes: 150, stagingBytes: 100, staging: 1 });
    expect(cache.isProtected('parent')).toBe(true);
    expect(cache.reconcile(['child'], ['child'], 'view')).toEqual(['parent']);
    cache.release('parent');
    expect(cache.diagnostics).toMatchObject({ committedBytes: 100, residentBytes: 100, staging: 0 });
    expect(cache.admit('parent')).toBe(false);
  });
  it('drops the raw traversal extra even when the committed frontier did not change', () => {
    const cache = controller(); cache.admit('chosen'); cache.loaded('chosen', 180);
    cache.reconcile(['chosen'], ['chosen'], 'view');
    cache.admit('extra'); cache.loaded('extra', 36);
    expect(cache.reconcile(['chosen'], ['chosen'], 'view')).toEqual(['extra']);
    cache.release('extra');
    for (let frame = 0; frame < 100; frame++) {
      expect(cache.admit('extra')).toBe(false);
      expect(cache.reconcile(['chosen'], ['chosen'], 'view')).toEqual([]);
    }
    cache.reconcile(['chosen'], ['chosen'], 'different-view');
    expect(cache.admit('extra')).toBe(true);
  });
  it('rejects a single oversized tile while keeping the old parent and native remainder', () => {
    const cache = controller(); cache.admit('parent'); cache.loaded('parent', 190);
    cache.reconcile(['parent'], ['parent'], 'view'); cache.admit('oversize');
    expect(cache.loaded('oversize', 193)).toBe(false);
    expect(cache.reconcile(['parent'], ['parent'], 'view')).toEqual(['oversize']);
    cache.release('oversize'); expect(cache.admit('oversize')).toBe(false);
    expect(cache.isProtected('parent')).toBe(true);
  });
  it('retries a detail rejected under the previous frontier when a completed bank swap frees enough memory',()=>{
    const cache=controller();cache.admit('old');cache.loaded('old',170);cache.reconcile(['old'],['old'],'same-camera');
    cache.admit('foreground');cache.loaded('foreground',65);
    expect(cache.reconcile(['old'],['old'],'same-camera')).toEqual(['foreground']);cache.release('foreground');
    expect(cache.admit('foreground')).toBe(false);
    cache.admit('replacement');cache.loaded('replacement',51);
    cache.reconcile(['old'],['replacement'],'same-camera');
    expect(cache.admit('foreground')).toBe(false);
    expect(cache.reconcile(['replacement'],['replacement'],'same-camera')).toEqual(['old']);cache.release('old');
    expect(cache.admit('foreground')).toBe(true);
    cache.loaded('foreground',65);cache.reconcile(['replacement'],['replacement','foreground'],'same-camera');
    cache.reconcile(['replacement','foreground'],['replacement','foreground'],'same-camera');
    expect(cache.diagnostics.committedBytes).toBe(116);
  });
  it('does not use released capacity to retry corrupt or individually oversized resources',()=>{
    const cache=controller();cache.admit('old');cache.loaded('old',170);cache.reconcile(['old'],['old'],'view');
    cache.admit('bad');cache.reject('bad');cache.release('bad');
    cache.admit('huge');cache.loaded('huge',200);cache.reject('huge');cache.release('huge');
    cache.reconcile([],[],'view');cache.release('old');
    expect(cache.admit('bad')).toBe(false);expect(cache.admit('huge')).toBe(false);
  });
  it('releases failed staging without permitting repeated corrupt-child loads in the same epoch', () => {
    const cache = controller(); cache.admit('parent'); cache.loaded('parent', 150);
    cache.reconcile(['parent'], ['parent'], 'view'); cache.admit('bad');
    cache.reject('bad'); cache.release('bad');
    expect(cache.admit('bad')).toBe(false); expect(cache.admit('other')).toBe(true);
    expect(cache.isProtected('parent')).toBe(true);
  });
  it('refuses an over-budget or unavailable committed frontier without changing retention', () => {
    const cache = controller(); cache.admit('a'); cache.loaded('a', 110); cache.admit('b'); cache.loaded('b', 100);
    expect(() => cache.reconcile(['a', 'b'], ['a', 'b'], 'view')).toThrow(/budget/);
    expect(() => cache.reconcile(['missing'], [], 'view')).toThrow(/available/);
    expect(cache.diagnostics.committedBytes).toBe(0);
  });
  it('does not turn a parent into a third staging buffer while a bank swap is pending', () => {
    const cache = controller(); cache.admit('parent'); cache.loaded('parent', 160);
    cache.reconcile(['parent'], ['parent'], 'view'); cache.admit('a'); cache.admit('b');
    cache.loaded('a', 70); cache.loaded('b', 70);
    expect(cache.reconcile(['parent'], ['a', 'b'], 'view')).toEqual([]);
    expect(cache.diagnostics.staging).toBe(2); expect(cache.admit('c')).toBe(false);
  });
  it('bounds denial metadata and resets it on an explicit material view epoch', () => {
    const cache = new BuildingCacheAdmission({ maxBytes: 192, maxStaging: 2, maxDenied: 2 });
    cache.reject('a'); cache.reject('b'); cache.reject('c');
    expect(cache.diagnostics.denied).toBe(2); expect(cache.admit('d')).toBe(false);
    cache.reconcile([], [], 'new-view'); expect(cache.admit('d')).toBe(true);
  });
  it('uses coarse stable camera buckets instead of frame time or tiny camera noise', () => {
    const camera = { longitude: 61.4, latitude: 55.17, zoom: 17.8, bearing: 20, pitch: 45 };
    const epoch = buildingCacheCameraEpoch(camera);
    expect(buildingCacheCameraEpoch({ ...camera, longitude: camera.longitude + 1e-8, zoom: 17.80001 })).toBe(epoch);
    expect(buildingCacheCameraEpoch({ ...camera, zoom: 18.4 })).not.toBe(epoch);
    expect(buildingCacheCameraEpoch({ ...camera, longitude: 61.42 })).not.toBe(epoch);
  });
});
