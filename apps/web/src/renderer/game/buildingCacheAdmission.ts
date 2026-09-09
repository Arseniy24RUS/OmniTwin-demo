interface Entry { bytes: number; loaded: boolean; reviewed:boolean }
interface Denial { bytes:number; availableBytes:number; reason:'capacity'|'resource' }
export interface BuildingCacheAdmissionOptions { maxBytes: number; maxStaging?: number; maxDenied?: number }

/** Geometry-only admission beside TilesRenderer's advisory LRU. Metadata does not
 * enter this controller and must never be removed using its retirement list.
 *
 * Integration: override LRU.add only for GLBs: admit(key) before super.add, and
 * release(key) if add fails or its removal callback runs. Record loaded geometry
 * bytes from load-model. Reconcile after traversal AND after the atomic native
 * bank commit, then call public LRU.remove for returned keys. Its explicit
 * removals bypass the library's intentional one-tile byte overshoot. Pin keys
 * for which isProtected is true after traversal; do not override markUsed.
 * Override isFull for geometry admission if the old retained frontier already
 * fills the advisory budget: staging is separately bounded here, including
 * pending entries that the default LRU reports as zero bytes.
 */
export class BuildingCacheAdmission {
  private readonly entries = new Map<string, Entry>();
  private readonly denied = new Map<string,Denial>();
  private committed = new Set<string>();
  private candidate = new Set<string>();
  private epoch: string | null = null;
  private saturated = false;
  readonly maxBytes: number;
  readonly maxStaging: number;
  private readonly maxDenied: number;

  constructor(options: BuildingCacheAdmissionOptions) {
    this.maxBytes = options.maxBytes;
    this.maxStaging = options.maxStaging ?? 2;
    this.maxDenied = options.maxDenied ?? 4096;
    if (![this.maxBytes, this.maxStaging, this.maxDenied].every(n => Number.isSafeInteger(n) && n > 0)
      || this.maxStaging > 2 || this.maxDenied > 32768) throw Error('Invalid building cache admission budget');
  }

  /** Called only for a new GLB cache entry, before a download or parse can start. */
  admit(key: string): boolean {
    if (!key) throw Error('Missing building cache key');
    if (this.entries.has(key)) return true;
    const denial=this.denied.get(key),availableBytes=this.availableBytes;
    // A previous larger committed bank can have caused a transient rejection.
    // Retry only after genuinely increased capacity can contain the known tile;
    // identical frames and failed/corrupt resources must never form a reload loop.
    if(denial?.reason==='capacity'&&availableBytes>denial.availableBytes&&denial.bytes<=availableBytes)this.denied.delete(key);
    if (this.saturated || this.denied.has(key) || this.diagnostics.staging >= this.maxStaging) return false;
    this.entries.set(key, { bytes: 0, loaded: false, reviewed:false });
    return true;
  }

  /** False means retain native coverage and remove this uncommitted GLB. */
  loaded(key: string, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('Invalid building geometry bytes');
    const entry = this.entries.get(key);
    if (!entry) throw Error('Building geometry loaded without a staging reservation');
    entry.bytes = bytes; entry.loaded = true; entry.reviewed=false;
    if (bytes > this.maxBytes) { this.reject(key); return false; }
    return true;
  }

  reject(key: string, reason:'capacity'|'resource'='resource'): void {
    if (this.committed.has(key)) throw Error('Cannot reject committed building geometry');
    if (this.denied.has(key)) return;
    if (this.denied.size >= this.maxDenied) this.saturated = true;
    else this.denied.set(key,{reason,bytes:this.entries.get(key)?.bytes??0,availableBytes:this.availableBytes});
  }

  /** Called by the cache removal callback, including cancellation and teardown. */
  release(key: string): void {
    this.entries.delete(key); this.committed.delete(key); this.candidate.delete(key);
  }

  /** A ready native-bank swap may retire many committed meshes at once. Their
   * previous candidate must then fit the remaining staging slots; it cannot
   * inherit the old committed allocation. Pending downloads keep their slots.
   * Candidate order is caller priority, and this method does not release owners. */
  rebaseCandidate(committedKeys:readonly string[],candidateKeys:readonly string[]):string[]{
    const committed=this.validateFrontier(committedKeys);this.validateFrontier(candidateKeys);
    let slots=this.maxStaging-[...this.entries].filter(([key,entry])=>(!entry.loaded||!entry.reviewed)&&!committed.has(key)&&!candidateKeys.includes(key)).length;
    return candidateKeys.filter(key=>committed.has(key)||slots-->0);
  }

  /** Pass the CURRENT committed frontier until its matching native bank is ready.
   * Calling this for an unchanged frontier is essential: raw traversal may have
   * loaded an extra tile that fitBuildingFrontier excluded without a bank swap.
   * Returned loaded keys must be removed synchronously before another admission.
   * Pending staging remains reserved, so slow children survive an unrelated swap.
   */
  reconcile(committedKeys: readonly string[], candidateKeys: readonly string[], cameraEpoch: string,
    {frontierReviewed=true}:{frontierReviewed?:boolean}={}): string[] {
    if (!cameraEpoch) throw Error('Missing building camera epoch');
    // A bank callback can run in prerender after load-model but before the next
    // traversal considers the new mesh. Such parsed staging is still reserved;
    // an older candidate is not evidence that it was excluded by the frontier.
    if(frontierReviewed)for(const entry of this.entries.values())if(entry.loaded)entry.reviewed=true;
    const committed = this.validateFrontier(committedKeys), candidate = this.validateFrontier(candidateKeys);
    if ([...candidate].filter(key => !committed.has(key)).length > this.maxStaging) throw Error('Building staging count exceeds budget');
    if (this.epoch !== cameraEpoch) { this.epoch = cameraEpoch; this.denied.clear(); this.saturated = false; }
    this.committed = committed; this.candidate = candidate;
    const evict: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.loaded && entry.reviewed && !committed.has(key) && !candidate.has(key)) {
        this.reject(key,entry.bytes>this.maxBytes?'resource':'capacity'); evict.push(key);
      }
    }
    return evict.sort();
  }

  isProtected(key: string): boolean {
    const entry = this.entries.get(key);
    return Boolean(entry && !this.denied.has(key)
      && (this.committed.has(key) || this.candidate.has(key) || !entry.loaded || !entry.reviewed));
  }

  get diagnostics() {
    let committedBytes = 0, stagingBytes = 0, staging = 0, residentBytes = 0, pending = 0;
    for (const [key, entry] of this.entries) {
      residentBytes += entry.bytes;
      if (this.committed.has(key)) committedBytes += entry.bytes;
      else { staging++; stagingBytes += entry.bytes; }
      if (!entry.loaded) pending++;
    }
    return { committedBytes, stagingBytes, residentBytes, staging, pending, denied: this.denied.size, saturated: this.saturated };
  }

  private get availableBytes():number{
    const sum=(keys:ReadonlySet<string>)=>[...keys].reduce((bytes,key)=>bytes+(this.entries.get(key)?.bytes??0),0);
    // Pending native bank work still owns the old visible frontier.
    return Math.max(0,this.maxBytes-Math.max(sum(this.committed),sum(this.candidate)));
  }

  private validateFrontier(keys: readonly string[]): Set<string> {
    const result = new Set(keys); let bytes = 0;
    if (result.size !== keys.length) throw Error('Duplicate building frontier key');
    for (const key of result) {
      const entry = this.entries.get(key);
      if (!entry?.loaded) throw Error('Committed or candidate building geometry is not available');
      bytes += entry.bytes;
    }
    if (bytes > this.maxBytes) throw Error('Building frontier exceeds retained geometry budget');
    return result;
  }
}

/** Approximately 100 m, half-zoom, 30-degree heading and 10-degree pitch bins.
 * The caller may instead supply a hysteretic epoch anchored to its last camera. */
export function buildingCacheCameraEpoch(camera: { longitude: number; latitude: number; zoom: number; bearing: number; pitch: number }): string {
  if (!Object.values(camera).every(Number.isFinite)) throw Error('Invalid building cache camera');
  return [Math.round(camera.longitude * Math.cos(camera.latitude * Math.PI / 180) * 1000), Math.round(camera.latitude * 1000),
    Math.round(camera.zoom * 2), Math.round(((camera.bearing % 360) + 360) % 360 / 30), Math.round(camera.pitch / 10)].join(':');
}
