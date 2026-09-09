import { describe, expect, it, vi } from 'vitest';
import type { LayerSpecification } from 'maplibre-gl';
import type { VerifiedCityBuildingSnapshot } from '../verifiedCityBuildingTypes';
import { CanonicalBuildingBanks, type CanonicalBankCommit } from './CanonicalBuildingBanks';

type Listener = (event: { sourceId?: string; error?: unknown }) => void;
class Source {
  data: unknown;
  ready = true;
  write: (() => Promise<void>) | null = null;
  listeners = new Map<string, Set<Listener>>();
  async setData(data: unknown) { await this.write?.(); this.data = data; }
  on(name: string, listener: Listener) { const set = this.listeners.get(name) ?? new Set(); set.add(listener); this.listeners.set(name, set); }
  off(name: string, listener: Listener) { this.listeners.get(name)?.delete(listener); }
  emit(name: string, event: { error?: unknown }) { this.listeners.get(name)?.forEach(listener => listener(event)); }
}
class MapMock {
  sources = new Map<string, Source>();
  layers = new Map<string, LayerSpecification>([['fallback', { id: 'fallback', type: 'fill-extrusion', source: 'omt' }]]);
  listeners = new Map<string, Set<Listener>>();
  nextSource: Source | null = null;
  getSource(id: string) { return this.sources.get(id); }
  addSource(id: string, _definition: unknown) { this.sources.set(id, this.nextSource ?? new Source()); this.nextSource = null; }
  removeSource(id: string) { this.sources.delete(id); }
  getLayer(id: string) { return this.layers.get(id); }
  addLayer(layer: LayerSpecification) { this.layers.set(layer.id, layer); }
  removeLayer(id: string) { this.layers.delete(id); }
  setLayoutProperty(id: string, _name: string, value: unknown) { const layer = this.layers.get(id)!; layer.layout = { ...layer.layout, visibility: value as 'visible' | 'none' }; }
  setPaintProperty(id: string, name: string, value: unknown) { const layer = this.layers.get(id)!; layer.paint = { ...layer.paint, [name]: value } as typeof layer.paint; }
  triggerRepaint() { queueMicrotask(() => this.listeners.get('render')?.forEach(listener => listener({}))); }
  isSourceLoaded(id: string) { return this.sources.get(id)?.ready ?? false; }
  on(name: string, listener: Listener) { const set = this.listeners.get(name) ?? new Set(); set.add(listener); this.listeners.set(name, set); }
  off(name: string, listener: Listener) { const set = this.listeners.get(name); set?.delete(listener); if (!set?.size) this.listeners.delete(name); }
  emit(sourceId: string) { this.listeners.get('sourcedata')?.forEach(listener => listener({ sourceId })); }
  visible(id: string) { return this.layers.get(id)?.layout?.visibility !== 'none'; }
}
function snapshot(ids = ['building:a', 'building:b']): VerifiedCityBuildingSnapshot {
  return { datasetVersion: 'source-v1', signature: ids.join('|'), canonicalIds: new Set(ids), cells: ['16/1/1'], coverage: 'complete_viewport',
    invalidBuildings: 0, omittedBuildings: 0, vertexCount: ids.length * 5,
    data: { type: 'FeatureCollection', features: ids.map(id => ({ type: 'Feature', id, properties: { canonical_id: id, height: 12 },
      geometry: { type: 'Polygon', coordinates: [[[61, 55], [61.01, 55], [61.01, 55.01], [61, 55.01], [61, 55]]] } })) } };
}
const options = { idPrefix: 'test-canonical', fallbackLayerIds: ['fallback'],
  layerTemplates: [{ id: 'walls', type: 'fill-extrusion', source: 'unused', 'source-layer': 'building', paint: { 'fill-extrusion-height': ['get', 'height'] } }] as LayerSpecification[] };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('canonical building source-bank ownership', () => {
  it('can keep the fallback worker buckets warm with zero opacity for immediate camera-boundary handover', async () => {
    const map=new MapMock();
    map.sources.set('omt',new Source());
    const template={id:'fallback',type:'fill-extrusion',source:'omt',paint:{'fill-extrusion-opacity':.85}} as LayerSpecification;
    map.layers.set('fallback',structuredClone(template));
    const banks=new CanonicalBuildingBanks(map,{...options,layerTemplates:[template],keepFallbackPrepared:true});
    await banks.stage(snapshot(),new Set(),()=>{});
    expect(map.visible('fallback')).toBe(true);
    expect(map.layers.get('fallback')?.paint).toMatchObject({'fill-extrusion-opacity':0,'fill-extrusion-opacity-transition':{duration:0,delay:0}});
    banks.activateFallback(()=>{});
    expect(map.layers.get('fallback')?.paint).toMatchObject({'fill-extrusion-opacity':.85});
    banks.dispose();
  });
  it('waits for both worker data and source readiness, then commits exactly the matching mesh frontier', async () => {
    const map = new MapMock(), source = new Source(); source.ready = false; map.nextSource = source;
    const banks = new CanonicalBuildingBanks(map, options), full = snapshot();
    const commit = vi.fn((value: CanonicalBankCommit) => {
      expect(value.mode).toBe('canonical'); expect(map.visible('fallback')).toBe(true);
      expect(value.meshOwnedIds).toEqual(new Set(['building:a']));
    });
    const pending = banks.stage(full, new Set(['building:a']), commit); await flush();
    expect(commit).not.toHaveBeenCalled(); expect(map.visible('fallback')).toBe(true);
    const [sourceId] = map.sources.keys(); source.ready = true; map.emit(sourceId!);
    expect(await pending).toBe(true); expect(commit).toHaveBeenCalledTimes(1);
    expect(map.visible('fallback')).toBe(false); expect(banks.snapshot).toBe(full);
    expect((source.data as typeof full.data).features.map(feature => feature.id)).toEqual(['building:b']);
    const layer = [...map.layers.values()].find(layer => layer.id !== 'fallback')!;
    expect(layer).not.toHaveProperty('source-layer'); expect(map.visible(layer.id)).toBe(true);
    banks.dispose();
  });
  it('keeps the active bank on a worker error even if setData resolves', async () => {
    const map = new MapMock(), banks = new CanonicalBuildingBanks(map, options), initial = snapshot();
    await banks.stage(initial, new Set(), () => {});
    const broken = new Source(); broken.write = async () => { broken.emit('error', { error: new Error('worker rejected') }); }; map.nextSource = broken;
    const commit = vi.fn(); expect(await banks.stage(snapshot(['building:c']), new Set(), commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled(); expect(banks.snapshot).toBe(initial); expect(map.visible('fallback')).toBe(false);
    expect(banks.diagnostics.lastError).toMatch(/worker rejected/); banks.dispose();
  });
  it('cancels stale preparation and never overlaps writes to the same inactive source', async () => {
    const map = new MapMock(), source = new Source(); let release!: () => void;
    source.write = () => new Promise<void>(resolve => { release = resolve; }); map.nextSource = source;
    const banks = new CanonicalBuildingBanks(map, options), oldCommit = vi.fn(), nextCommit = vi.fn();
    const first = banks.stage(snapshot(['building:a']), new Set(), oldCommit); await flush();
    const second = banks.stage(snapshot(['building:b']), new Set(), nextCommit); await flush();
    expect(nextCommit).not.toHaveBeenCalled(); source.write = null; release();
    expect(await first).toBe(false); expect(await second).toBe(true);
    expect(oldCommit).not.toHaveBeenCalled(); expect(nextCommit).toHaveBeenCalledTimes(1);
    expect(banks.snapshot?.canonicalIds).toEqual(new Set(['building:b'])); banks.dispose();
  });
  it('switches to whole OMT fallback for incomplete coarse snapshots, independently of mesh IDs', async () => {
    const map = new MapMock();map.sources.set('omt',new Source());const banks = new CanonicalBuildingBanks(map, options); await banks.stage(snapshot(), new Set(), () => {});
    const commit = vi.fn(); const incomplete = { ...snapshot(), coverage: 'partial_viewport' as const };
    expect(await banks.stage(incomplete, new Set(['building:a']), commit)).toBe(true);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ mode: 'fallback', snapshot: null, meshOwnedIds: new Set() }));
    expect(map.visible('fallback')).toBe(true); expect(banks.snapshot).toBeNull();
    expect([...map.layers].filter(([id]) => id !== 'fallback').every(([id]) => !map.visible(id))).toBe(true); banks.dispose();
  });
  it('rejects a foreign mesh ID and over-budget candidate without changing the committed bank', async () => {
    const map = new MapMock(), banks = new CanonicalBuildingBanks(map, { ...options, maxFeatures: 2 }); const initial = snapshot();
    await banks.stage(initial, new Set(), () => {}); const commit = vi.fn();
    expect(await banks.stage(initial, new Set(['foreign']), commit)).toBe(false);
    expect(await banks.stage(snapshot(['a', 'b', 'c']), new Set(), commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled(); expect(banks.snapshot).toBe(initial); banks.dispose();
  });
  it('budgets both retained banks and reports encoded GeoJSON bytes without claiming GPU memory', async () => {
    const initial = snapshot(['building:a']), bytes = new TextEncoder().encode(JSON.stringify(initial.data)).byteLength;
    const map = new MapMock(), banks = new CanonicalBuildingBanks(map, { ...options, maxBytes: bytes * 2 - 1 });
    await banks.stage(initial, new Set(), () => {});
    expect(await banks.stage(snapshot(['building:b']), new Set(), () => {})).toBe(false);
    expect(banks.diagnostics.retainedBytes).toBe(bytes); expect(banks.diagnostics.memoryMetric).toBe('serialized_geojson_bytes'); banks.dispose();
  });
  it('can replace the frontier without rebuilding GeoJSON when ownership and source content are unchanged', async () => {
    const map = new MapMock(), banks = new CanonicalBuildingBanks(map, options), full = snapshot();
    await banks.stage(full, new Set(['building:a']), () => {}); const source = [...map.sources.values()][0]!;
    const write = vi.spyOn(source, 'setData'), commit = vi.fn();
    expect(await banks.stage({ ...full }, new Set(['building:a']), commit)).toBe(true);
    expect(write).not.toHaveBeenCalled(); expect(commit).toHaveBeenCalledTimes(1); banks.dispose();
  });
  it('bounds readiness waiting and cleans only owned sources/layers on disposal', async () => {
    vi.useFakeTimers();
    try {
      const map = new MapMock(), source = new Source(); source.ready = false; map.nextSource = source;
      const banks = new CanonicalBuildingBanks(map, { ...options, readinessTimeoutMs: 20 }), commit = vi.fn();
      const pending = banks.stage(snapshot(), new Set(), commit); await flush(); await vi.advanceTimersByTimeAsync(21);
      expect(await pending).toBe(false); expect(commit).not.toHaveBeenCalled();
      expect(banks.diagnostics.lastError).toMatch(/readiness/);
      banks.dispose(); expect(map.sources.size).toBe(0); expect([...map.layers.keys()]).toEqual(['fallback']);
      expect(map.visible('fallback')).toBe(true); expect(map.listeners.size).toBe(0);
      expect(await banks.stage(snapshot(), new Set(), commit)).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('does not remove an unrelated source that occupies a reserved bank ID', async () => {
    const map = new MapMock(), foreign = new Source(); map.sources.set('test-canonical-source-0', foreign);
    const banks = new CanonicalBuildingBanks(map, options);
    expect(await banks.stage(snapshot(), new Set(), vi.fn())).toBe(false); banks.dispose();
    expect(map.sources.get('test-canonical-source-0')).toBe(foreign);
  });
  it('deduplicates pending source content while using the newest matching frontier callback', async () => {
    const map = new MapMock(), source = new Source(); source.ready = false; map.nextSource = source;
    const banks = new CanonicalBuildingBanks(map, options), first = vi.fn(), latest = vi.fn(), full = snapshot();
    const write = vi.spyOn(source, 'setData');
    const one = banks.stage(full, new Set(['building:a']), first); await flush();
    const two = banks.stage(full, new Set(['building:a']), latest);
    expect(two).toBe(one); expect(write).toHaveBeenCalledTimes(1);
    source.ready = true; map.emit([...map.sources.keys()][0]!); expect(await two).toBe(true);
    expect(first).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledTimes(1);
    expect(banks.sourceId).toBe('test-canonical-source-0'); expect(banks.layerIds).toHaveLength(1); banks.dispose();
  });
  it('does not resurrect disposed diagnostics after an uncancellable worker write completes', async () => {
    const map = new MapMock(), source = new Source(); let release!: () => void;
    source.write = () => new Promise<void>(resolve => { release = resolve; }); map.nextSource = source;
    const banks = new CanonicalBuildingBanks(map, options), callback = vi.fn();
    const pending = banks.stage(snapshot(), new Set(), callback); await flush(); banks.dispose(); release();
    expect(await pending).toBe(false); expect(callback).not.toHaveBeenCalled();
    expect(banks.diagnostics).toMatchObject({ state: 'disposed', retainedBytes: 0, reservedBytes: 0 });
    expect(map.sources.size).toBe(0); expect(source.listeners.get('error')?.size ?? 0).toBe(0);
  });
  it('warms actual extrusion buckets transparently and never treats unused source readiness as rendered readiness', async () => {
    const map = new MapMock(); map.triggerRepaint = vi.fn();
    const banks = new CanonicalBuildingBanks(map, options), callback = vi.fn();
    const pending = banks.stage(snapshot(), new Set(), callback); await flush();
    const staged = [...map.layers.values()].find(layer => layer.id !== 'fallback')!;
    expect(staged.layout?.visibility).toBe('visible');
    expect(staged.paint).toMatchObject({ 'fill-extrusion-opacity': 0, 'fill-extrusion-opacity-transition': { duration: 0, delay: 0 } });
    expect(callback).not.toHaveBeenCalled(); expect(map.triggerRepaint).toHaveBeenCalledTimes(1);
    map.listeners.get('render')?.forEach(listener => listener({})); expect(await pending).toBe(true);
    expect(staged.paint).toMatchObject({ 'fill-extrusion-opacity': 1 }); banks.dispose();
  });
  it('reclaims only the inactive old payload when a third generation exceeds the upload reservation budget', async () => {
    const initial = snapshot(['building:a']), bytes = new TextEncoder().encode(JSON.stringify(initial.data)).byteLength;
    const map = new MapMock(), banks = new CanonicalBuildingBanks(map, { ...options, maxBytes: bytes * 2 });
    expect(await banks.stage(initial, new Set(), () => {})).toBe(true);
    expect(await banks.stage(snapshot(['building:b']), new Set(), () => {})).toBe(true);
    const activeSource = banks.sourceId, remove = vi.spyOn(map, 'removeSource');
    expect(await banks.stage(snapshot(['building:c']), new Set(), () => {})).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalledWith(activeSource);
    expect(banks.diagnostics.retainedBytes).toBeLessThanOrEqual(bytes * 2); expect(map.sources.size).toBe(2); banks.dispose();
  });
  it('preserves template-disabled material layers and their filters through warm-up and commit', async () => {
    const map = new MapMock(), template: LayerSpecification = { ...options.layerTemplates[0]!, id: 'motion',
      layout: { visibility: 'none' }, filter: ['==', ['get', 'mode'], 'motion'] } as LayerSpecification;
    const banks = new CanonicalBuildingBanks(map, { ...options, layerTemplates: [...options.layerTemplates, template] });
    await banks.stage(snapshot(), new Set(), () => {});
    const motion = [...map.layers.values()].find(layer => layer.id.endsWith('-motion'))!;
    expect(motion.layout?.visibility).toBe('none'); expect(motion.filter).toEqual(template.filter); banks.dispose();
  });
  it('retains the drawable bank if native fallback has no ready source during a coverage escape',async()=>{
    const map=new MapMock(),native=new Source();native.ready=false;native.data={type:'FeatureCollection',features:[]};map.sources.set('omt',native);
    const template={id:'fallback',type:'fill-extrusion',source:'omt',paint:{'fill-extrusion-opacity':1}} as LayerSpecification;
    map.layers.set('fallback',structuredClone(template));
    const banks=new CanonicalBuildingBanks(map,{...options,layerTemplates:[template],keepFallbackPrepared:true}),full=snapshot();
    await banks.stage(full,new Set(['building:a']),()=>{});const activeSourceId=banks.sourceId,commit=vi.fn();
    // The viewport has escaped the verified extent while native tile requests
    // fail. Warming at opacity zero does not make an unavailable source drawable.
    expect(await banks.stage(null,new Set(),commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();expect(banks.sourceId).toBe(activeSourceId);expect(banks.snapshot).toBe(full);
    expect(map.layers.get(banks.layerIds[0]!)?.paint).toMatchObject({'fill-extrusion-opacity':1});banks.dispose();
  });
  it('recovers only on successful native content and invokes the latest explicitly retried callback',async()=>{
    const map=new MapMock(),native=new Source();native.ready=false;map.sources.set('omt',native);
    const banks=new CanonicalBuildingBanks(map,options),old=vi.fn(),latest=vi.fn();await banks.stage(snapshot(),new Set(['building:a']),()=>{});
    expect(await banks.stage(null,new Set(),old)).toBe(false);expect(banks.diagnostics.fallbackPending).toBe(true);
    native.ready=true;expect(banks.noteNativeSourceData({sourceId:'omt',sourceDataType:'metadata'})).toBe(false);
    expect(banks.noteNativeSourceData({sourceId:'foreign',sourceDataType:'content'})).toBe(false);
    expect(banks.noteNativeSourceData({sourceId:'omt',sourceDataType:'content'})).toBe(true);
    expect(old).not.toHaveBeenCalled();expect(await banks.stage(null,new Set(),latest)).toBe(true);
    expect(latest).toHaveBeenCalledTimes(1);expect(old).not.toHaveBeenCalled();expect(banks.snapshot).toBeNull();expect(banks.diagnostics.fallbackPending).toBe(false);banks.dispose();
  });
  it('does not treat errored-but-loaded native tiles as drawable and clears only subsequent successful content',async()=>{
    const map=new MapMock(),native=new Source();map.sources.set('omt',native);const banks=new CanonicalBuildingBanks(map,options);await banks.stage(snapshot(),new Set(),()=>{});
    map.listeners.get('error')?.forEach(listener=>listener({sourceId:'omt',error:new Error('native tile failed')}));
    expect(await banks.stage(null,new Set(),vi.fn())).toBe(false);
    expect(banks.noteNativeSourceData({sourceId:'omt',sourceDataType:'metadata'})).toBe(false);
    expect(banks.noteNativeSourceData({sourceId:'omt',sourceDataType:'content',tile:{state:'errored'}})).toBe(false);
    expect(banks.noteNativeSourceData({sourceId:'other',sourceDataType:'content'})).toBe(false);
    expect(banks.noteNativeSourceData({sourceId:'omt',tile:{state:'loaded'}})).toBe(true);
    expect(await banks.stage(null,new Set(),vi.fn())).toBe(true);banks.dispose();expect(map.listeners.size).toBe(0);
  });
  it('cancels pending fallback on a newer canonical request and cleans error tracking on disposal',async()=>{
    const map=new MapMock(),native=new Source();native.ready=false;map.sources.set('omt',native);const banks=new CanonicalBuildingBanks(map,options),stale=vi.fn();
    await banks.stage(snapshot(),new Set(),()=>{});expect(await banks.stage(null,new Set(),stale)).toBe(false);
    expect(await banks.stage(snapshot(['building:new']),new Set(),()=>{})).toBe(true);expect(banks.diagnostics.fallbackPending).toBe(false);
    native.ready=true;expect(banks.noteNativeSourceData({sourceId:'omt',sourceDataType:'content'})).toBe(false);expect(stale).not.toHaveBeenCalled();
    expect(banks.snapshot?.canonicalIds).toEqual(new Set(['building:new']));banks.dispose();expect(map.listeners.size).toBe(0);
    expect(banks.noteNativeSourceData({sourceId:'omt',sourceDataType:'content'})).toBe(false);
  });
  it('does not let an unrelated successful tile hide another outstanding native tile error',async()=>{
    const map=new MapMock();map.sources.set('omt',new Source());const banks=new CanonicalBuildingBanks(map,options);await banks.stage(snapshot(),new Set(),()=>{});
    const errorListener=[...map.listeners.get('error')!][0]!;
    errorListener({sourceId:'omt',error:new Error('failed tile'),coord:{key:'16/100/200'}} as Parameters<typeof banks.noteNativeSourceData>[0]);
    expect(await banks.stage(null,new Set(),vi.fn())).toBe(false);
    expect(banks.noteNativeSourceData({sourceId:'omt',tile:{state:'loaded'},coord:{key:'16/101/200'}})).toBe(false);
    expect(banks.diagnostics.fallbackBlockedSources).toEqual(['omt']);
    expect(banks.noteNativeSourceData({sourceId:'omt',tile:{state:'loaded'},coord:{key:'16/100/200'}})).toBe(true);
    expect(await banks.stage(null,new Set(),vi.fn())).toBe(true);banks.dispose();
  });
});
