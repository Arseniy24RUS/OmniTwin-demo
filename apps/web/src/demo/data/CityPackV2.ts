/** Immutable, viewport-scoped municipal geography. No whole-city browser index. */
export type CityBoundsV2 = [west: number, south: number, east: number, north: number];
export interface CityAssetV2 { url: string; sha256: string; bytes: number; gzip?: { url: string; sha256: string; bytes: number } }
export interface CityBuildingV2 {
  index: number;
  id: string;
  aliases: string[];
  center: [number, number];
  districtId: string | null;
  use: 'residential' | 'study' | 'work' | 'unknown';
  areaM2: number;
  levels: number | null;
  heightM: number;
  heightQuality: string;
  capacityWeight: number;
  classificationProvenance: string;
  capacityRepresentation?: string;
  name?: string | null;
  sourceAttributes?: Record<string, string>;
  footprint?: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
}
export interface CityRoadV2 {
  id: string;
  coordinates: [number, number][];
  nodeIds: string[];
  oneway: boolean;
  walkable: boolean;
  drivable: boolean;
  className: string;
  startNodeId: string;
  endNodeId: string;
  lanes: number | null;
  maxspeed: number | null;
  bridge: boolean;
  tunnel: boolean;
  layer: number;
  name?: string | null;
}
export interface CityCellV2 { contract: 'DemoCityCellV2'; key: string; bbox: CityBoundsV2; buildings: CityBuildingV2[]; roads: CityRoadV2[] }
export interface CityCellDescriptorV2 extends CityAssetV2 { key: string; bbox: CityBoundsV2; buildingCount: number; roadCount: number }
export interface CityBuildingPageDescriptorV2 extends CityAssetV2 { firstIndex: number; count: number; firstId: string; lastId: string }
export interface CityPackManifestV2 {
  contract: 'DemoCityPackManifestV2';
  packId: string;
  datasetVersion: string;
  bounds: CityBoundsV2;
  coverage: { districtIds: string[]; [key: string]: unknown };
  boundaries?: CityAssetV2;
  buildingIndex?: CityAssetV2 & { count: number; columns: string[] };
  buildingPages: CityBuildingPageDescriptorV2[];
  buildingPageSize: number;
  cells: CityCellDescriptorV2[];
  cellZoom: number;
}
export interface CityPackLoaderOptionsV2 {
  maxActiveCells?: number;
  maxCachedCells?: number;
  maxCachedBytes?: number;
  maxBuildingPages?: number;
  fetcher?: typeof fetch;
  preferGzip?: boolean;
}
export interface CityViewportCameraV2 { longitude: number; latitude: number; zoom: number; pitch?: number; bearing?: number }
interface BuildingPage { contract: 'DemoBuildingPageV2'; firstIndex: number; buildings: CityBuildingV2[] }
const abortError = () => new DOMException('Geography request was superseded', 'AbortError');
const abortIfNeeded = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };
const intersects = (a: CityBoundsV2, b: CityBoundsV2) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const emptyLayout = () => ({ buildings: [] as CityBuildingV2[], roads: [] as CityRoadV2[] });
async function boundedResponseBytes(response: Response, maximum: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new Error('City response exceeds declared byte budget'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result.buffer;
}

/** Exact documented OSM feature-type aliases, not a fuzzy geographic/name join. */
export function canonicalCityBuildingId(value: string): string | null {
  const match = /^openmaptiles_buildings:(\d+)$/u.exec(value);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id)) return null;
  const kind = id % 10;
  if (kind !== 0 && kind !== 2 && kind !== 3) return null;
  return `openmaptiles_buildings:${kind === 2 ? id - 2 : id}`;
}

export class CityPackV2 {
  readonly manifest: CityPackManifestV2;
  readonly baseURL: string;
  private readonly fetcher: typeof fetch;
  private readonly maxActive: number;
  private readonly maxCached: number;
  private readonly maxBytes: number;
  private readonly maxPages: number;
  private readonly preferGzip: boolean;
  private readonly cells = new Map<string, { data: CityCellV2; bytes: number }>();
  private readonly pages = new Map<string, BuildingPage>();
  private active: CityCellV2[] = [];
  private layout = emptyLayout();
  private buildingLookup = new Map<string, CityBuildingV2>();
  private viewportController: AbortController | null = null;
  private viewportEpoch = 0;
  private requestCount = 0;
  private state: 'empty' | 'loading' | 'ready' | 'stale' = 'empty';
  private error: string | null = null;

  private constructor(baseURL: string, manifest: CityPackManifestV2, options: CityPackLoaderOptionsV2) {
    this.baseURL = baseURL;
    this.manifest = manifest;
    // Native Window.fetch cannot be invoked with this CityPack instance as its
    // receiver. Bind once, including explicitly injected native implementations.
    this.fetcher = (options.fetcher ?? globalThis.fetch).bind(globalThis);
    this.maxActive = Math.max(1, Math.min(64, options.maxActiveCells ?? 48));
    this.maxCached = Math.max(this.maxActive, Math.min(128, options.maxCachedCells ?? 64));
    this.maxBytes = Math.max(2 * 1024 * 1024, options.maxCachedBytes ?? 16 * 1024 * 1024);
    this.maxPages = Math.max(1, Math.min(16, options.maxBuildingPages ?? 4));
    this.preferGzip = options.preferGzip ?? true;
  }

  static async load(baseURL: string, manifest?: CityPackManifestV2, signal?: AbortSignal, options: CityPackLoaderOptionsV2 = {}): Promise<CityPackV2> {
    const base = new URL(baseURL.endsWith('/') ? baseURL : `${baseURL}/`, globalThis.location?.href ?? 'http://localhost/').href;
    abortIfNeeded(signal);
    let supplied = manifest;
    if (!supplied) {
      const response = await (options.fetcher ?? globalThis.fetch).call(globalThis, new URL('manifest.json', base), { signal, cache: 'no-cache' });
      if (!response.ok) throw new Error(`City manifest HTTP ${response.status}`);
      const bytes = await boundedResponseBytes(response, 8 * 1024 * 1024);
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('City manifest exceeds 8 MiB');
      supplied = JSON.parse(new TextDecoder().decode(bytes)) as CityPackManifestV2;
    }
    if (supplied.contract !== 'DemoCityPackManifestV2' || supplied.cellZoom !== 16
      || !Array.isArray(supplied.cells) || !Array.isArray(supplied.buildingPages)
      || new Set(supplied.cells.map(c => c.key)).size !== supplied.cells.length) throw new Error('Invalid city pack V2 manifest');
    return new CityPackV2(base, supplied, options);
  }

  get telemetry() {
    return { packId: this.manifest.packId, status: this.state, error: this.error, activeCells: this.active.length,
      residentCells: this.cells.size, cachedCellBytes: [...this.cells.values()].reduce((sum, c) => sum + c.bytes, 0),
      cachedBuildingPages: this.pages.size, requests: this.requestCount };
  }
  getLayout() { return this.layout; }
  getActiveCells(): readonly CityCellV2[] { return this.active; }
  getBuilding(id: string): CityBuildingV2 | null {
    const canonical = canonicalCityBuildingId(id);
    if (!canonical) return null;
    const active = this.buildingLookup.get(canonical);
    if (active) return active;
    for (const page of this.pages.values()) { const found = page.buildings.find(b => b.id === canonical); if (found) return found; }
    return null;
  }

  private viewportDescriptors(camera: CityViewportCameraV2, supplied?: CityBoundsV2): CityCellDescriptorV2[] {
    if (![camera.longitude, camera.latitude, camera.zoom].every(Number.isFinite)) throw new Error('Invalid city camera');
    const radians = camera.latitude * Math.PI / 180;
    // Caller should supply actual MapLibre bounds. Conservative fallback is only for initial load.
    const radiusM = Math.min(3000, Math.max(350, 700 * 2 ** (16.5 - camera.zoom)));
    const dy = radiusM / 110540, dx = radiusM / (111320 * Math.cos(radians));
    const bounds = supplied ?? [camera.longitude - dx, camera.latitude - dy, camera.longitude + dx, camera.latitude + dy];
    if (!bounds.every(Number.isFinite) || bounds[0] > bounds[2] || bounds[1] > bounds[3]) throw new Error('Invalid city viewport bounds');
    // One z16 guard cell in map coordinates; cells entirely outside declared coverage do not exist.
    const guardX = 360 / 65536, guardY = guardX * Math.cos(radians);
    const expanded: CityBoundsV2 = [bounds[0] - guardX, bounds[1] - guardY, bounds[2] + guardX, bounds[3] + guardY];
    const candidates = this.manifest.cells.filter(c => intersects(c.bbox, expanded)).sort((a, b) => {
      const distance = (c: CityCellDescriptorV2) => ((c.bbox[0] + c.bbox[2]) / 2 - camera.longitude) ** 2 * Math.cos(radians) ** 2
        + ((c.bbox[1] + c.bbox[3]) / 2 - camera.latitude) ** 2;
      return distance(a) - distance(b) || a.key.localeCompare(b.key);
    });
    const selected: CityCellDescriptorV2[] = []; let bytes = 0;
    for (const candidate of candidates) {
      if (selected.length >= this.maxActive) break;
      if (bytes + candidate.bytes > this.maxBytes) continue;
      bytes += candidate.bytes; selected.push(candidate);
    }
    return selected;
  }

  async updateViewport(camera: CityViewportCameraV2, bbox?: CityBoundsV2, signal?: AbortSignal): Promise<CityCellV2[]> {
    abortIfNeeded(signal);
    this.viewportController?.abort();
    const controller = new AbortController(); this.viewportController = controller;
    const epoch = ++this.viewportEpoch;
    const forwardAbort = () => controller.abort(); signal?.addEventListener('abort', forwardAbort, { once: true });
    this.state = 'loading'; this.error = null;
    try {
      const descriptors = this.viewportDescriptors(camera, bbox);
      const next = new Array<CityCellV2>(descriptors.length);
      let cursor = 0;
      const loadNext = async () => {
        while (cursor < descriptors.length) {
          abortIfNeeded(controller.signal);
          const index = cursor++, descriptor = descriptors[index]!;
          const cached = this.cells.get(descriptor.key);
          if (cached) {
            next[index] = cached.data; this.cells.delete(descriptor.key); this.cells.set(descriptor.key, cached); continue;
          }
          const data = await this.fetchAsset<CityCellV2>(descriptor, controller.signal);
          if (data.contract !== 'DemoCityCellV2' || data.key !== descriptor.key
            || data.buildings.length !== descriptor.buildingCount || data.roads.length !== descriptor.roadCount) throw new Error(`Invalid city cell ${descriptor.key}`);
          abortIfNeeded(controller.signal);
          next[index] = data; this.cells.set(descriptor.key, { data, bytes: descriptor.bytes });
        }
      };
      // Two downloads, not a large parse/network burst on a phone or the owner's active model PC.
      await Promise.all([loadNext(), loadNext()]);
      abortIfNeeded(controller.signal); if (epoch !== this.viewportEpoch) throw abortError();
      this.active = next;
      this.rebuildLayout(); this.evict(); this.state = 'ready'; this.error = null;
      return next;
    } catch (error) {
      controller.abort();
      if (epoch === this.viewportEpoch) { this.state = this.active.length ? 'stale' : 'empty'; this.error = error instanceof Error ? error.message : String(error); this.evict(); }
      throw error;
    } finally { signal?.removeEventListener('abort', forwardAbort); }
  }

  private rebuildLayout() {
    const buildings = new Map<string, CityBuildingV2>(), roads = new Map<string, CityRoadV2>();
    for (const cell of this.active) {
      for (const b of cell.buildings) buildings.set(b.id, b);
      for (const r of cell.roads) roads.set(r.id, r);
    }
    this.buildingLookup = buildings;
    this.layout = { buildings: [...buildings.values()], roads: [...roads.values()] };
  }
  private evict() {
    const active = new Set(this.active.map(c => c.key));
    let bytes = [...this.cells.values()].reduce((sum, c) => sum + c.bytes, 0);
    for (const [key, value] of this.cells) {
      if (this.cells.size <= this.maxCached && bytes <= this.maxBytes) break;
      if (!active.has(key)) { this.cells.delete(key); bytes -= value.bytes; }
    }
  }
  private async verify(bytes: ArrayBuffer, descriptor: { bytes: number; sha256: string }) {
    if (bytes.byteLength !== descriptor.bytes) throw new Error('City asset length mismatch');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
    if (actual !== descriptor.sha256) throw new Error('City asset hash mismatch');
  }
  private async fetchAsset<T>(descriptor: CityAssetV2, signal?: AbortSignal): Promise<T> {
    if (descriptor.bytes > 4 * 1024 * 1024) throw new Error('City asset exceeds 4 MiB');
    const compressed = this.preferGzip && typeof DecompressionStream !== 'undefined' ? descriptor.gzip : undefined;
    const request = async (url: string) => { this.requestCount++; return this.fetcher(new URL(url, this.baseURL), { signal, cache: 'force-cache' }); };
    let response = await request(compressed?.url ?? descriptor.url);
    if (!response.ok && compressed && [404, 415, 501].includes(response.status)) response = await request(descriptor.url);
    if (!response.ok) throw new Error(`City asset HTTP ${response.status}`);
    let bytes = await boundedResponseBytes(response, Math.max(descriptor.bytes, compressed?.bytes ?? 0)); abortIfNeeded(signal);
    // GCS may advertise Content-Encoding:gzip and fetch then transparently decodes it.
    if (compressed && bytes.byteLength !== descriptor.bytes) {
      await this.verify(bytes, compressed);
      bytes = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    await this.verify(bytes, descriptor); abortIfNeeded(signal);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }
  private async buildingPage(descriptor: CityBuildingPageDescriptorV2, signal?: AbortSignal): Promise<BuildingPage> {
    abortIfNeeded(signal);
    const cached = this.pages.get(descriptor.url);
    if (cached) { this.pages.delete(descriptor.url); this.pages.set(descriptor.url, cached); return cached; }
    const page = await this.fetchAsset<BuildingPage>(descriptor, signal);
    if (page.contract !== 'DemoBuildingPageV2' || page.firstIndex !== descriptor.firstIndex || page.buildings.length !== descriptor.count) throw new Error('Invalid city building page');
    this.pages.set(descriptor.url, page);
    while (this.pages.size > this.maxPages) this.pages.delete(this.pages.keys().next().value!);
    return page;
  }
  async loadBuildingByIndex(index: number, signal?: AbortSignal): Promise<CityBuildingV2 | null> {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    const descriptor = this.manifest.buildingPages[Math.floor(index / this.manifest.buildingPageSize)];
    if (!descriptor || index < descriptor.firstIndex || index >= descriptor.firstIndex + descriptor.count) return null;
    const page = await this.buildingPage(descriptor, signal); return page.buildings[index - descriptor.firstIndex] ?? null;
  }
  async loadBuilding(id: string, signal?: AbortSignal): Promise<CityBuildingV2 | null> {
    abortIfNeeded(signal);
    const canonical = canonicalCityBuildingId(id); if (!canonical) return null;
    const cached = this.getBuilding(canonical); if (cached) return cached;
    const descriptor = this.manifest.buildingPages.find(p => canonical.localeCompare(p.firstId) >= 0 && canonical.localeCompare(p.lastId) <= 0);
    if (!descriptor) return null;
    const page = await this.buildingPage(descriptor, signal); return page.buildings.find(b => b.id === canonical) ?? null;
  }
  dispose() {
    this.viewportController?.abort(); this.viewportEpoch++;
    this.cells.clear(); this.pages.clear(); this.active = []; this.buildingLookup.clear(); this.layout = emptyLayout(); this.state = 'empty';
  }
}
