import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import type { VerifiedCityBuildingSnapshot } from '../verifiedCityBuildingTypes';

type SourceEvent = { sourceId?: string; error?: unknown; sourceDataType?: string; tile?: {state?:string;tileID?:{key?:string|number}}; coord?:{key?:string|number} };
type Listener = (event: SourceEvent) => void;
interface BankSource {
  setData(data: VerifiedCityBuildingSnapshot['data']): unknown;
  on(name: string, listener: Listener): unknown;
  off(name: string, listener: Listener): unknown;
}
export interface CanonicalBuildingMap {
  getSource(id: string): unknown;
  addSource(id: string, source: SourceSpecification): unknown;
  removeSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: LayerSpecification, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  setLayoutProperty(id: string, name: string, value: unknown): unknown;
  setPaintProperty(id: string, name: string, value: unknown): unknown;
  triggerRepaint(): unknown;
  isSourceLoaded(id: string): boolean;
  on(name: string, listener: Listener): unknown;
  off(name: string, listener: Listener): unknown;
}
export interface CanonicalBuildingBankOptions {
  idPrefix?: string;
  /** Exact native material layers to replicate. Original IDs are never removed. */
  layerTemplates: readonly LayerSpecification[];
  fallbackLayerIds: readonly string[];
  beforeLayerId?: string;
  maxFeatures?: number;
  maxVertices?: number;
  /** Combined encoded GeoJSON of both retained banks; not a browser/GPU heap estimate. */
  maxBytes?: number;
  readinessTimeoutMs?: number;
  /** Warm the original native buckets transparently so a camera escape is drawable now. */
  keepFallbackPrepared?: boolean;
}
export interface CanonicalBankCommit {
  mode: 'canonical' | 'fallback';
  generation: number;
  ownershipKey: string;
  /** Full exact geometry, including mesh-owned buildings, remains the picking authority. */
  snapshot: VerifiedCityBuildingSnapshot | null;
  meshOwnedIds: ReadonlySet<string>;
}
type CommitFrontier = (commit: CanonicalBankCommit) => void;
interface Bank {
  sourceId: string;
  layerIds: string[];
  source: BankSource | null;
  features: number;
  vertices: number;
  bytes: number;
}
interface Request {
  generation: number;
  key: string;
  snapshot: VerifiedCityBuildingSnapshot;
  ids: ReadonlySet<string>;
  callback: CommitFrontier;
  controller: AbortController;
}
const abortError = () => new DOMException('Canonical building preparation superseded', 'AbortError');
const complete = (snapshot: VerifiedCityBuildingSnapshot | null) => snapshot?.coverage === 'complete_viewport'
  && snapshot.invalidBuildings === 0 && snapshot.omittedBuildings === 0;

/** Stable deduplication key: camera-only coverage changes do not rewrite native geometry. */
export function canonicalBuildingOwnershipKey(snapshot: VerifiedCityBuildingSnapshot | null, meshOwnedIds: ReadonlySet<string>): string {
  return !complete(snapshot) ? 'fallback' : JSON.stringify([snapshot!.datasetVersion, snapshot!.signature, [...meshOwnedIds].sort()]);
}

/**
 * Two bounded native GeoJSON banks. Worker preparation never changes the visible
 * bank; a synchronous callback commits the matching, externally pinned GLB frontier.
 * Caller owns mesh lifetime and must not mutate supplied exact snapshots.
 */
export class CanonicalBuildingBanks {
  snapshot: VerifiedCityBuildingSnapshot | null = null;
  private readonly banks: readonly [Bank, Bank];
  private readonly limits: { features: number; vertices: number; bytes: number; timeout: number };
  private readonly fallbackVisibility: ReadonlyMap<string, 'visible' | 'none'>;
  private generation = 0;
  private activeBank: number | null = null;
  private committedKey = 'fallback';
  private request: Request | null = null;
  private pending: Promise<boolean> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private state: 'idle' | 'staging' | 'canonical' | 'fallback' | 'fallback_pending' | 'error' | 'disposed' = 'idle';
  private lastError: string | null = null;
  private reservedBytes = 0;
  private readonly nativeSourceIds:ReadonlySet<string>;
  private readonly nativeErrors=new Map<string,{unknown:boolean;overflow:boolean;tiles:Set<string>}>();
  private fallbackPending=false;

  constructor(private readonly map: CanonicalBuildingMap, private readonly options: CanonicalBuildingBankOptions) {
    const prefix = options.idPrefix ?? 'omnitwin-game-canonical';
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(prefix) || !options.layerTemplates.length
      || new Set(options.layerTemplates.map(layer => layer.id)).size !== options.layerTemplates.length
      || options.layerTemplates.some(layer => !['fill', 'fill-extrusion', 'line'].includes(layer.type))) {
      throw new Error('Canonical banks require explicit unique building material layers');
    }
    for (const layer of options.layerTemplates) {
      const opacity = (layer.paint as Record<string, unknown> | undefined)?.[opacityProperty(layer)];
      if (opacity !== undefined && (typeof opacity !== 'number' || opacity < 0 || opacity > 1)) {
        throw new Error('Canonical staging requires constant building layer opacity');
      }
    }
    this.fallbackVisibility = new Map(options.fallbackLayerIds.map(id => [id,
      options.layerTemplates.find(layer => layer.id === id)?.layout?.visibility === 'none' ? 'none' : 'visible']));
    this.nativeSourceIds=new Set(options.fallbackLayerIds.flatMap(id=>{
      const layer=(map.getLayer(id)??options.layerTemplates.find(layer=>layer.id===id)) as LayerSpecification|undefined;
      return this.fallbackVisibility.get(id)!=='none'&&layer&&'source' in layer&&typeof layer.source==='string'?[layer.source]:[];
    }));
    const limit = (value: number | undefined, fallback: number) => {
      const result = value ?? fallback;
      if (!Number.isSafeInteger(result) || result < 1) throw new Error('Canonical bank limits must be positive integers');
      return result;
    };
    this.limits = { features: limit(options.maxFeatures, 12_000), vertices: limit(options.maxVertices, 500_000),
      bytes: limit(options.maxBytes, 32 * 1024 * 1024), timeout: limit(options.readinessTimeoutMs, 10_000) };
    this.banks = [0, 1].map(index => ({ sourceId: `${prefix}-source-${index}`,
      layerIds: options.layerTemplates.map(layer => `${prefix}-bank-${index}-${layer.id}`),
      source: null, features: 0, vertices: 0, bytes: 0 })) as [Bank, Bank];
    map.on('error',this.nativeSourceError);
  }

  get diagnostics() {
    return { state: this.state, generation: this.generation, activeBank: this.activeBank,
      activeSourceId: this.sourceId,
      ownershipKey: this.committedKey, requestedOwnershipKey: this.request?.key ?? null,
      pending: this.request !== null, fallbackPending:this.fallbackPending,
      fallbackBlockedSources:this.fallbackPending?this.blockedNativeSources():[],lastError: this.lastError,
      retainedFeatures: this.banks.reduce((sum, bank) => sum + bank.features, 0),
      retainedVertices: this.banks.reduce((sum, bank) => sum + bank.vertices, 0),
      retainedBytes: this.banks.reduce((sum, bank) => sum + bank.bytes, 0),
      reservedBytes: this.reservedBytes, maxBytes: this.limits.bytes,
      memoryMetric: 'serialized_geojson_bytes' as const };
  }
  get sourceId(): string | null { return this.activeBank === null ? null : this.banks[this.activeBank]!.sourceId; }
  get layerIds(): readonly string[] { return this.activeBank === null ? [] : [...this.banks[this.activeBank]!.layerIds]; }

  stage(snapshot: VerifiedCityBuildingSnapshot | null, meshOwnedIds: ReadonlySet<string>, callback: CommitFrontier): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (!complete(snapshot)) return Promise.resolve(this.activateFallback(callback));
    this.fallbackPending=false;
    const key = canonicalBuildingOwnershipKey(snapshot, meshOwnedIds);
    // Keep the newest matching frontier callback without repeatedly cancelling its worker.
    if (this.request?.key === key && this.pending) {
      this.request.callback = callback; this.request.snapshot = snapshot!;
      return this.pending;
    }
    this.cancelRequest();
    const generation = ++this.generation;
    if (this.activeBank !== null && key === this.committedKey) {
      try {
        callback({ mode: 'canonical', generation, ownershipKey: key, snapshot, meshOwnedIds: new Set(meshOwnedIds) });
        this.snapshot = snapshot; this.state = 'canonical'; this.lastError = null;
        return Promise.resolve(true);
      } catch (error) { this.recordError(error); return Promise.resolve(false); }
    }
    const request: Request = { generation, key, snapshot: snapshot!, ids: new Set(meshOwnedIds), callback, controller: new AbortController() };
    this.request = request; this.state = 'staging'; this.lastError = null;
    // setData has no cancellation API. Serialize writes even when a superseded
    // request is still inside MapLibre's worker; its result must never commit.
    const pending = this.tail.then(() => this.prepare(request));
    this.tail = pending.catch(() => {});
    this.pending = pending;
    return pending;
  }

  activateFallback(callback: CommitFrontier): boolean {
    if (this.disposed) return false;
    this.cancelRequest(); const generation = ++this.generation;
    const blocked=this.blockedNativeSources();
    if(this.activeBank!==null&&blocked.length){
      // The old exact polygons remain useful in the overlapping part of the
      // viewport. Never unmask an empty/failed fallback and retire them first.
      this.fallbackPending=true;this.state='fallback_pending';this.lastError=`Native fallback is not drawable: ${blocked.join(', ')}`;
      this.showBank(this.activeBank);return false;
    }
    try {
      callback({ mode: 'fallback', generation, ownershipKey: 'fallback', snapshot: null, meshOwnedIds: new Set() });
      this.showBank(null); this.activeBank = null; this.snapshot = null; this.committedKey = 'fallback';
      this.state = 'fallback'; this.fallbackPending=false;this.lastError = null;
      return true;
    } catch (error) { this.recordError(error); return false; }
  }

  /** The caller retries with its CURRENT camera/snapshot/frontier. No deferred
   * callback is kept here that could replay an obsolete ownership transaction. */
  noteNativeSourceData(event:SourceEvent):boolean{
    const id=event.sourceId;
    if(this.disposed||!id||!this.nativeSourceIds.has(id)||!this.map.getSource(id)||event.error)return false;
    const success=event.tile?event.tile.state==='loaded'&&(!event.sourceDataType||event.sourceDataType==='content'):event.sourceDataType==='content';
    if(!success)return false;
    const errors=this.nativeErrors.get(id),key=nativeTileKey(event);
    if(errors){
      if(!event.tile){errors.tiles.clear();errors.unknown=false;errors.overflow=false;}
      else{if(key)errors.tiles.delete(key);errors.unknown=false;}
      if(!errors.unknown&&!errors.overflow&&!errors.tiles.size)this.nativeErrors.delete(id);
    }
    return this.fallbackPending&&this.blockedNativeSources().length===0;
  }
  private nativeSourceError=(event:SourceEvent):void=>{
    const id=event.sourceId;if(this.disposed||!id||!this.nativeSourceIds.has(id))return;
    const errors=this.nativeErrors.get(id)??{unknown:false,overflow:false,tiles:new Set<string>()},key=nativeTileKey(event);
    if(!key)errors.unknown=true;else if(errors.tiles.size<512||errors.tiles.has(key))errors.tiles.add(key);else errors.overflow=true;
    this.nativeErrors.set(id,errors);
  };
  private blockedNativeSources():string[]{
    return [...this.nativeSourceIds].filter(id=>{try{return this.nativeErrors.has(id)||!this.map.getSource(id)||!this.map.isSourceLoaded(id);}catch{return true;}});
  }

  private async prepare(request: Request): Promise<boolean> {
    let cleanup = () => {};
    let reserved = false;
    try {
      this.assertCurrent(request);
      const snapshot = request.snapshot;
      if (snapshot.data.features.length > this.limits.features || snapshot.vertexCount > this.limits.vertices
        || snapshot.data.features.length !== snapshot.canonicalIds.size) throw new Error('Canonical snapshot exceeds feature/vertex bounds');
      for (const id of request.ids) if (!snapshot.canonicalIds.has(id)) throw new Error('Mesh owner is absent from the exact canonical snapshot');
      const seen = new Set<string>();
      for (const feature of snapshot.data.features) {
        const id = feature.properties?.canonical_id;
        if (typeof id !== 'string' || feature.id !== id || seen.has(id) || !snapshot.canonicalIds.has(id)) throw new Error('Canonical feature identity mismatch');
        seen.add(id);
      }
      const data: VerifiedCityBuildingSnapshot['data'] = { type: 'FeatureCollection',
        features: snapshot.data.features.filter(feature => !request.ids.has(feature.properties!.canonical_id as string)) };
      const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
      const vertices = countVertices(data);
      if (vertices > this.limits.vertices) throw new Error('Canonical source exceeds the actual vertex budget');
      const index = this.activeBank === 0 ? 1 : 0, bank = this.banks[index]!;
      const otherBytes = this.banks[1 - index]!.bytes;
      if (bytes + otherBytes > this.limits.bytes) throw new Error('Canonical source banks exceed the combined byte budget');
      // A third generation may coexist with the old inactive bank during worker
      // upload. Reclaim that hidden bank first if all three payloads do not fit.
      if (bytes + otherBytes + bank.bytes > this.limits.bytes) this.releaseBank(bank);
      this.reservedBytes = bytes; reserved = true;
      const source = this.ensureBank(bank);
      this.stageBank(bank);
      let failure: unknown;
      let rejectReadiness: ((error: unknown) => void) | undefined;
      const sourceError: Listener = event => { failure = event.error ?? new Error('Canonical source worker rejected data'); rejectReadiness?.(failure); };
      source.on('error', sourceError); cleanup = () => source.off('error', sourceError);
      await source.setData(data);
      if (this.disposed) return false;
      if (this.map.getSource(bank.sourceId) !== source) throw new Error('Canonical source ownership changed during preparation');
      // Source data may have changed even if a source error was emitted. Account
      // the larger known payload until this inactive bank is safely overwritten.
      bank.bytes = Math.max(bank.bytes, bytes);
      bank.features = Math.max(bank.features, data.features.length);
      bank.vertices = Math.max(bank.vertices, vertices);
      if (failure) throw failure;
      bank.bytes = bytes; bank.features = data.features.length; bank.vertices = vertices;
      this.reservedBytes = 0;
      this.assertCurrent(request);
      if (this.map.getSource(bank.sourceId) !== source) throw new Error('Canonical source ownership changed during preparation');
      // Hidden layers mark the source unused, and the worker skips their buckets.
      // Stage the real layers at zero opacity; a subsequent rendered frame must
      // request/prepare their viewport tiles before source readiness can qualify.
      await new Promise<void>((resolve, reject) => {
          let rendered = false;
          rejectReadiness = reject;
          const finish = (error?: unknown) => {
            clearTimeout(timer); this.map.off('sourcedata', ready); this.map.off('render', frame);
            request.controller.signal.removeEventListener('abort', aborted);
            rejectReadiness = undefined; error ? reject(error) : resolve();
          };
          const ready: Listener = event => {
            if (rendered && (!event.sourceId || event.sourceId === bank.sourceId) && this.map.isSourceLoaded(bank.sourceId)) finish();
          };
          const frame: Listener = () => { rendered = true; ready({}); };
          const aborted = () => finish(abortError());
          const timer = setTimeout(() => finish(new Error('Canonical source readiness timed out')), this.limits.timeout);
          rejectReadiness = error => finish(error);
          this.map.on('sourcedata', ready); this.map.on('render', frame);
          request.controller.signal.addEventListener('abort', aborted, { once: true });
          if (request.controller.signal.aborted) aborted(); else this.map.triggerRepaint();
        });
      if (failure) throw failure;
      this.assertCurrent(request);
      request.callback({ mode: 'canonical', generation: request.generation, ownershipKey: request.key,
        snapshot, meshOwnedIds: request.ids });
      this.showBank(index);
      bank.features = data.features.length; bank.vertices = vertices; bank.bytes = bytes;
      this.activeBank = index; this.snapshot = snapshot; this.committedKey = request.key;
      this.state = 'canonical'; this.lastError = null;
      return true;
    } catch (error) {
      if (this.request === request && !request.controller.signal.aborted && !this.disposed) this.recordError(error);
      return false;
    } finally {
      cleanup();
      if (reserved) this.reservedBytes = 0;
      if (this.request === request) {
        this.request = null; this.pending = null;
        if (this.state !== 'canonical') this.showBank(this.activeBank);
      }
    }
  }

  private ensureBank(bank: Bank): BankSource {
    const existing = this.map.getSource(bank.sourceId);
    if (existing && existing !== bank.source) throw new Error('Canonical source ID is owned by another renderer');
    if (!existing) {
      if (bank.layerIds.some(id => this.map.getLayer(id))) throw new Error('Canonical layer ID is owned by another renderer');
      this.map.addSource(bank.sourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        generateId: false, promoteId: 'canonical_id', maxzoom: 18, tolerance: 0,
        attribution: '© OpenStreetMap contributors · SHA-256 verified source geometry' });
      bank.source = this.map.getSource(bank.sourceId) as BankSource;
      if (typeof bank.source?.setData !== 'function') throw new Error('Canonical bank source is not retained GeoJSON');
      const before = this.options.beforeLayerId && this.map.getLayer(this.options.beforeLayerId) ? this.options.beforeLayerId : undefined;
      for (let index = 0; index < this.options.layerTemplates.length; index++) {
        const template = this.options.layerTemplates[index]!;
        const layer = { ...template, id: bank.layerIds[index]!, source: bank.sourceId,
          layout: { ...template.layout, visibility: 'none' },
          paint: { ...template.paint, [opacityProperty(template)]: 0,
            [`${opacityProperty(template)}-transition`]: { duration: 0, delay: 0 } } } as LayerSpecification;
        delete (layer as unknown as Record<string, unknown>)['source-layer'];
        this.map.addLayer(layer, before);
      }
    }
    return bank.source!;
  }

  private showBank(active: number | null): void {
    for (let index = 0; index < this.banks.length; index++) {
      for (let layerIndex = 0; layerIndex < this.banks[index]!.layerIds.length; layerIndex++) {
        const id = this.banks[index]!.layerIds[layerIndex]!, template = this.options.layerTemplates[layerIndex]!;
        if (!this.map.getLayer(id)) continue;
        const property = opacityProperty(template), opacity = (template.paint as Record<string, unknown> | undefined)?.[property] ?? 1;
        this.map.setPaintProperty(id, property, index === active ? opacity : 0);
        this.map.setLayoutProperty(id, 'visibility', index === active && template.layout?.visibility !== 'none' ? 'visible' : 'none');
      }
    }
    for (const id of this.options.fallbackLayerIds) if (this.map.getLayer(id)) {
      const template=this.options.layerTemplates.find(layer=>layer.id===id);
      if(this.options.keepFallbackPrepared&&template){
        const property=opacityProperty(template),opacity=(template.paint as Record<string,unknown>|undefined)?.[property]??1;
        this.map.setPaintProperty(id,`${property}-transition`,{duration:0,delay:0});
        this.map.setPaintProperty(id,property,active===null?opacity:0);
        this.map.setLayoutProperty(id,'visibility',this.fallbackVisibility.get(id)!);
      }else this.map.setLayoutProperty(id, 'visibility', active === null ? this.fallbackVisibility.get(id)! : 'none');
    }
  }
  private stageBank(bank: Bank): void {
    for (let index = 0; index < bank.layerIds.length; index++) {
      const id = bank.layerIds[index]!, template = this.options.layerTemplates[index]!;
      this.map.setPaintProperty(id, opacityProperty(template), 0);
      this.map.setLayoutProperty(id, 'visibility', template.layout?.visibility === 'none' ? 'none' : 'visible');
    }
  }
  private assertCurrent(request: Request): void {
    if (this.disposed || this.request !== request || request.generation !== this.generation || request.controller.signal.aborted) throw abortError();
  }
  private cancelRequest(): void {
    this.request?.controller.abort(); this.request = null; this.pending = null;
  }
  private recordError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : 'Canonical bank preparation failed'; this.state = 'error';
  }
  private releaseBank(bank: Bank): void {
    if (bank.source && this.map.getSource(bank.sourceId) === bank.source) {
      for (const id of bank.layerIds) if (this.map.getLayer(id)) this.map.removeLayer(id);
      this.map.removeSource(bank.sourceId);
    }
    bank.source = null; bank.bytes = bank.features = bank.vertices = 0;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.cancelRequest(); this.fallbackPending=false;this.map.off('error',this.nativeSourceError);this.nativeErrors.clear();this.showBank(null);
    for (const bank of this.banks) this.releaseBank(bank);
    this.activeBank = null; this.snapshot = null; this.reservedBytes = 0; this.state = 'disposed';
  }
}

function countVertices(data: VerifiedCityBuildingSnapshot['data']): number {
  let count = 0;
  for (const feature of data.features) {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) for (const ring of polygon) count += ring.length;
  }
  return count;
}
function opacityProperty(layer: LayerSpecification): string {
  return `${layer.type}-opacity`;
}
function nativeTileKey(event:SourceEvent):string|null{const value=event.coord?.key??event.tile?.tileID?.key;return (typeof value==='string'||typeof value==='number')&&String(value).length<=160?String(value):null;}
