import type { WorldCamera } from './types';

export const SCENE_STREAM_ZOOM = 16 as const;
const MAX_MERCATOR_LATITUDE = 85.05112878;

export type SceneCachePolicy = 'auto' | 'memory' | 'persistent';
export type SceneDeviceTier = 'low' | 'medium' | 'high';
export type SceneResourceCacheClass = 'immutable-scene-asset' | 'focus-trajectory';

export interface SceneCell {
  z: typeof SCENE_STREAM_ZOOM;
  x: number;
  y: number;
  key: string;
}

export interface SceneCellLoadRequest {
  cell: SceneCell;
  signal: AbortSignal;
  revision: number;
  cachePolicy: SceneCachePolicy;
  memoryBudgetBytes: number | null;
  deviceTier: SceneDeviceTier | null;
}

export interface SceneStreamerSnapshot {
  currentCell: string | null;
  desiredCells: number;
  activeCells: number;
  loadedCells: number;
  pendingCells: number;
  failedCells: number;
  budgetCells: number;
  loadedBytes: number;
  memoryBudgetBytes: number | null;
  cachePolicy: SceneCachePolicy;
  deviceTier: SceneDeviceTier | null;
  evictedCells: number;
  rejectedCells: number;
  budgetDisposition:
    | 'not-configured'
    | 'within-budget'
    | 'evicted'
    | 'rejected-over-budget';
  revision: number;
  /** Camera-cell membership remains retained until an explicit moveend commit. */
  cameraMotion: 'idle' | 'moving' | 'staged';
  /** False means aggregate-only presentation and zero individual cell IO. */
  individualCellsEnabled: boolean;
}

export interface SceneStreamerOptions<T> {
  loadCell?: (request: SceneCellLoadRequest) => Promise<T>;
  releaseCell?: (resource: T, cell: SceneCell) => void;
  activateCell?: (resource: T, cell: SceneCell) => void;
  deactivateCell?: (resource: T, cell: SceneCell) => void;
  estimateBytes?: (resource: T, cell: SceneCell) => number;
  onChange?: (snapshot: SceneStreamerSnapshot) => void;
  onResourcesChange?: (resources: readonly SceneStreamResource<T>[]) => void;
  cachePolicy?: SceneCachePolicy;
  memoryBudgetBytes?: number;
  deviceTier?: SceneDeviceTier;
  budgetCells?: number;
}

export interface SceneStreamResource<T> {
  cell: SceneCell;
  resource: T;
  primary: boolean;
}

interface PendingCell {
  controller: AbortController;
  request: SceneCellLoadRequest;
}

interface LoadedCell<T> {
  cell: SceneCell;
  resource: T;
  bytes: number;
  active: boolean;
  primary: boolean;
  lastUsedRevision: number;
}

function wrapTileX(x: number, tileCount: number): number {
  return ((x % tileCount) + tileCount) % tileCount;
}

function clampTileY(y: number, tileCount: number): number {
  return Math.max(0, Math.min(tileCount - 1, y));
}

function sceneCell(z: typeof SCENE_STREAM_ZOOM, x: number, y: number): SceneCell {
  return { z, x, y, key: `${z}/${x}/${y}` };
}

/** Parses only canonical LivingCellSliceV1 z16 identifiers; invalid hints are ignored. */
export function sceneCellFromHint(cellId: string): SceneCell | null {
  const match = /^z16\/(\d{1,5})\/(\d{1,5})$/u.exec(cellId);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  const tileCount = 2 ** SCENE_STREAM_ZOOM;
  if (!Number.isInteger(x) || !Number.isInteger(y)
    || x < 0 || x >= tileCount || y < 0 || y >= tileCount) return null;
  return sceneCell(SCENE_STREAM_ZOOM, x, y);
}

export function sceneCellForCamera(
  camera: Pick<WorldCamera, 'longitude' | 'latitude'> | null | undefined,
): SceneCell | null {
  const tileCount = 2 ** SCENE_STREAM_ZOOM;
  if (
    !camera ||
    !Number.isFinite(camera.longitude) ||
    !Number.isFinite(camera.latitude) ||
    camera.longitude < -180 ||
    camera.longitude > 180 ||
    camera.latitude < -MAX_MERCATOR_LATITUDE ||
    camera.latitude > MAX_MERCATOR_LATITUDE
  ) return null;
  const longitude = camera.longitude;
  const latitude = camera.latitude;
  const x = wrapTileX(Math.floor(((longitude + 180) / 360) * tileCount), tileCount);
  const radians = (latitude * Math.PI) / 180;
  const y = clampTileY(
    Math.floor(
      ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * tileCount,
    ),
    tileCount,
  );
  return sceneCell(SCENE_STREAM_ZOOM, x, y);
}

/** Current z16 cell followed by its nearest one-cell neighbours. */
export function selectSceneCellHalo(
  current: SceneCell,
  radius = 1,
  budgetCells = (radius * 2 + 1) ** 2,
): SceneCell[] {
  const tileCount = 2 ** current.z;
  const cells = new Map<string, SceneCell>();
  cells.set(current.key, current);
  for (let distance = 1; distance <= radius * 2; distance += 1) {
    for (let deltaY = -radius; deltaY <= radius; deltaY += 1) {
      for (let deltaX = -radius; deltaX <= radius; deltaX += 1) {
        if (Math.abs(deltaX) + Math.abs(deltaY) !== distance) continue;
        const x = wrapTileX(current.x + deltaX, tileCount);
        const y = clampTileY(current.y + deltaY, tileCount);
        const candidate = sceneCell(current.z, x, y);
        if (!cells.has(candidate.key)) cells.set(candidate.key, candidate);
      }
    }
  }
  return [...cells.values()].slice(0, Math.max(1, Math.floor(budgetCells)));
}

/** Persistent CacheStorage is allowed only for immutable, non-focus assets. */
export function canUsePersistentSceneCache(
  policy: SceneCachePolicy,
  cacheClass: SceneResourceCacheClass,
): boolean {
  return policy === 'persistent' && cacheClass === 'immutable-scene-asset';
}

export class SceneStreamer<T = unknown> {
  private readonly loadCell?: (request: SceneCellLoadRequest) => Promise<T>;
  private readonly releaseCell?: (resource: T, cell: SceneCell) => void;
  private readonly activateCell?: (resource: T, cell: SceneCell) => void;
  private readonly deactivateCell?: (resource: T, cell: SceneCell) => void;
  private readonly estimateBytes?: (resource: T, cell: SceneCell) => number;
  private readonly onChange?: (snapshot: SceneStreamerSnapshot) => void;
  private readonly onResourcesChange?: (resources: readonly SceneStreamResource<T>[]) => void;
  private readonly cachePolicy: SceneCachePolicy;
  private readonly memoryBudgetBytes: number | null;
  private readonly deviceTier: SceneDeviceTier | null;
  private readonly budgetCells: number;
  private current: SceneCell | null = null;
  private exactHints = new Map<string, SceneCell>();
  private stagedCamera: Pick<WorldCamera, 'longitude' | 'latitude'> | null = null;
  private hasStagedCamera = false;
  private stagedExactHints: Map<string, SceneCell> | null = null;
  private cameraMoving = false;
  private individualCellsEnabled = true;
  private latestCamera: Pick<WorldCamera, 'longitude' | 'latitude'> | null = null;
  private desired = new Map<string, SceneCell>();
  private readonly pending = new Map<string, PendingCell>();
  private readonly loaded = new Map<string, LoadedCell<T>>();
  private readonly failed = new Set<string>();
  private revision = 0;
  private evictedCells = 0;
  private rejectedCells = 0;
  private budgetDisposition: SceneStreamerSnapshot['budgetDisposition'] = 'not-configured';
  private disposed = false;

  constructor({
    loadCell,
    releaseCell,
    activateCell,
    deactivateCell,
    estimateBytes,
    onChange,
    onResourcesChange,
    cachePolicy = 'auto',
    memoryBudgetBytes,
    deviceTier,
    budgetCells = 9,
  }: SceneStreamerOptions<T> = {}) {
    this.loadCell = loadCell;
    this.releaseCell = releaseCell;
    this.activateCell = activateCell;
    this.deactivateCell = deactivateCell;
    this.estimateBytes = estimateBytes;
    this.onChange = onChange;
    this.onResourcesChange = onResourcesChange;
    this.cachePolicy = cachePolicy;
    this.memoryBudgetBytes = Number.isFinite(memoryBudgetBytes)
      ? Math.max(0, Math.floor(memoryBudgetBytes ?? 0))
      : null;
    this.deviceTier = deviceTier ?? null;
    this.budgetCells = Math.max(1, Math.floor(budgetCells));
  }

  updateCamera(camera: Pick<WorldCamera, 'longitude' | 'latitude'> | null): void {
    if (this.disposed) return;
    this.latestCamera = camera;
    if (this.cameraMoving) {
      this.stagedCamera = camera;
      this.hasStagedCamera = true;
      return;
    }
    if (!this.individualCellsEnabled) return;
    this.commitCamera(camera);
  }

  /**
   * Aggregate/general-plan modes call this before updating the camera. All
   * identity-bearing z16 resources are released, and later camera changes are
   * remembered without starting IO. Re-enabling resumes at the latest camera.
   */
  setIndividualCellsEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.individualCellsEnabled) return;
    this.individualCellsEnabled = enabled;
    if (!enabled) {
      this.suspendIndividualCells();
      return;
    }
    if (this.cameraMoving) {
      this.publish();
      return;
    }
    if (this.latestCamera) this.commitCamera(this.latestCamera, true);
    else this.publish();
  }

  /** Starts a retained camera transaction; subsequent updates are staging-only. */
  beginCameraMove(): void {
    if (this.disposed) return;
    this.cameraMoving = true;
  }

  /** Commits the latest staged camera/hints once, matching MapLibre moveend semantics. */
  endCameraMove(camera?: Pick<WorldCamera, 'longitude' | 'latitude'> | null): void {
    if (this.disposed) return;
    if (camera !== undefined) {
      this.stagedCamera = camera;
      this.hasStagedCamera = true;
    }
    const stagedCamera = this.hasStagedCamera ? this.stagedCamera : undefined;
    const stagedHints = this.stagedExactHints;
    this.cameraMoving = false;
    this.stagedCamera = null;
    this.hasStagedCamera = false;
    this.stagedExactHints = null;
    if (stagedHints) this.exactHints = stagedHints;
    if (stagedCamera !== undefined) this.latestCamera = stagedCamera;
    if (!this.individualCellsEnabled) {
      this.publish();
      return;
    }
    if (stagedCamera !== undefined) this.commitCamera(stagedCamera, stagedHints !== null);
    else if (stagedHints && this.current) this.reconcileDesired();
  }

  private commitCamera(
    camera: Pick<WorldCamera, 'longitude' | 'latitude'> | null,
    forceReconcile = false,
  ): void {
    const current = sceneCellForCamera(camera);
    if (!current) {
      this.clearUnresolvedCamera();
      return;
    }
    if (current.key === this.current?.key && !forceReconcile) return;
    this.current = current;
    this.reconcileDesired();
  }

  /**
   * Adds contract-derived living cells after the current cell and before the
   * speculative halo. The fixed cell budget remains authoritative.
   */
  updateExactCells(cellIds: readonly string[]): void {
    if (this.disposed) return;
    const next = new Map<string, SceneCell>();
    for (const cellId of cellIds) {
      const cell = sceneCellFromHint(cellId);
      if (cell && !next.has(cell.key)) next.set(cell.key, cell);
      if (next.size >= this.budgetCells) break;
    }
    const currentHints = this.stagedExactHints ?? this.exactHints;
    if (next.size === currentHints.size
      && [...next.keys()].every((key, index) => key === [...currentHints.keys()][index])) return;
    if (this.cameraMoving) {
      this.stagedExactHints = next;
      return;
    }
    this.exactHints = next;
    if (this.current) this.reconcileDesired();
  }

  private reconcileDesired(): void {
    const current = this.current;
    if (!current) return;
    this.revision += 1;
    const candidates = new Map<string, SceneCell>();
    candidates.set(current.key, current);
    for (const hint of this.exactHints.values()) candidates.set(hint.key, hint);
    for (const halo of selectSceneCellHalo(current, 1, this.budgetCells)) {
      if (!candidates.has(halo.key)) candidates.set(halo.key, halo);
    }
    this.desired = new Map([...candidates].slice(0, this.budgetCells));
    this.failed.clear();

    for (const [key, pending] of this.pending) {
      if (this.desired.has(key)) continue;
      pending.controller.abort();
      this.pending.delete(key);
    }
    for (const [key, loaded] of this.loaded) {
      const desired = this.desired.has(key);
      const primary = key === current.key;
      if (loaded.primary && !primary) {
        loaded.primary = false;
        this.deactivateCell?.(loaded.resource, loaded.cell);
      }
      if (desired && !loaded.active) {
        loaded.active = true;
        loaded.lastUsedRevision = this.revision;
      }
      if (desired) {
        if (primary && !loaded.primary) {
          loaded.primary = true;
          this.activateCell?.(loaded.resource, loaded.cell);
        }
        continue;
      }
      if (!loaded.active) continue;
      loaded.active = false;
      loaded.lastUsedRevision = this.revision;
      if (this.memoryBudgetBytes === null) {
        this.loaded.delete(key);
        this.releaseCell?.(loaded.resource, loaded.cell);
      }
    }
    this.enforceBudget();
    for (const cell of this.desired.values()) {
      if (
        !this.loaded.has(cell.key) &&
        !this.pending.has(cell.key) &&
        !this.failed.has(cell.key)
      ) this.startLoad(cell);
    }
    this.publish();
  }

  snapshot(): SceneStreamerSnapshot {
    let loadedBytes = 0;
    for (const loaded of this.loaded.values()) loadedBytes += loaded.bytes;
    return {
      currentCell: this.current?.key ?? null,
      desiredCells: this.desired.size,
      activeCells: [...this.loaded.values()].filter((loaded) => loaded.active).length,
      loadedCells: this.loaded.size,
      pendingCells: this.pending.size,
      failedCells: this.failed.size,
      budgetCells: this.budgetCells,
      loadedBytes,
      memoryBudgetBytes: this.memoryBudgetBytes,
      cachePolicy: this.cachePolicy,
      deviceTier: this.deviceTier,
      evictedCells: this.evictedCells,
      rejectedCells: this.rejectedCells,
      budgetDisposition: this.budgetDisposition,
      revision: this.revision,
      cameraMotion: this.cameraMoving
        ? (this.hasStagedCamera || this.stagedExactHints ? 'staged' : 'moving')
        : 'idle',
      individualCellsEnabled: this.individualCellsEnabled,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear();
    for (const loaded of this.loaded.values()) {
      if (loaded.primary) this.deactivateCell?.(loaded.resource, loaded.cell);
      this.releaseCell?.(loaded.resource, loaded.cell);
    }
    this.loaded.clear();
    this.exactHints.clear();
    this.stagedExactHints = null;
    this.stagedCamera = null;
    this.hasStagedCamera = false;
    this.cameraMoving = false;
    this.latestCamera = null;
    this.desired.clear();
    this.onResourcesChange?.([]);
  }

  private startLoad(cell: SceneCell): void {
    if (!this.loadCell) return;
    const controller = new AbortController();
    const request: SceneCellLoadRequest = {
      cell,
      signal: controller.signal,
      revision: this.revision,
      cachePolicy: this.cachePolicy,
      memoryBudgetBytes: this.memoryBudgetBytes,
      deviceTier: this.deviceTier,
    };
    const pending = { controller, request };
    this.pending.set(cell.key, pending);
    void this.loadCell(request).then((resource) => {
      const stillCurrent = this.pending.get(cell.key) === pending;
      if (!stillCurrent || this.disposed || !this.desired.has(cell.key)) {
        this.releaseCell?.(resource, cell);
        return;
      }
      this.pending.delete(cell.key);
      const estimated = this.estimateBytes?.(resource, cell) ?? 0;
      const bytes = Number.isFinite(estimated) ? Math.max(0, Math.floor(estimated)) : 0;
      const loaded: LoadedCell<T> = {
        cell,
        resource,
        bytes,
        active: true,
        primary: cell.key === this.current?.key,
        lastUsedRevision: this.revision,
      };
      this.loaded.set(cell.key, loaded);
      const admitted = this.enforceBudget(loaded);
      if (!admitted) {
        this.failed.add(cell.key);
        this.publish();
        return;
      }
      if (loaded.primary) this.activateCell?.(resource, cell);
      this.failed.delete(cell.key);
      this.publish();
    }).catch((error: unknown) => {
      if (this.pending.get(cell.key) !== pending) return;
      this.pending.delete(cell.key);
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.failed.add(cell.key);
      this.publish();
    });
  }

  private publish(): void {
    const priority = new Map([...this.desired.keys()].map((key, index) => [key, index]));
    const resources = [...this.loaded.values()]
      .filter((loaded) => loaded.active && this.desired.has(loaded.cell.key))
      .toSorted((left, right) => (
        (priority.get(left.cell.key) ?? Number.MAX_SAFE_INTEGER) -
        (priority.get(right.cell.key) ?? Number.MAX_SAFE_INTEGER)
      ))
      .map(({ cell, resource, primary }) => ({ cell, resource, primary }));
    this.onResourcesChange?.(resources);
    this.onChange?.(this.snapshot());
  }

  private clearUnresolvedCamera(): void {
    if (!this.current && this.desired.size === 0 && this.pending.size === 0 && this.loaded.size === 0) {
      return;
    }
    this.current = null;
    this.exactHints.clear();
    this.revision += 1;
    this.desired.clear();
    this.failed.clear();
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear();
    for (const loaded of this.loaded.values()) {
      if (loaded.primary) this.deactivateCell?.(loaded.resource, loaded.cell);
      this.releaseCell?.(loaded.resource, loaded.cell);
    }
    this.loaded.clear();
    this.publish();
  }

  private suspendIndividualCells(): void {
    this.current = null;
    this.revision += 1;
    this.desired.clear();
    this.failed.clear();
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear();
    for (const loaded of this.loaded.values()) {
      if (loaded.primary) this.deactivateCell?.(loaded.resource, loaded.cell);
      this.releaseCell?.(loaded.resource, loaded.cell);
    }
    this.loaded.clear();
    this.publish();
  }

  /**
   * Keeps the deterministic priority subset: current cell, nearest active
   * halo, then most-recently-used inactive cache entries.
   */
  private enforceBudget(incoming?: LoadedCell<T>): boolean {
    if (this.memoryBudgetBytes === null) {
      this.budgetDisposition = 'not-configured';
      return true;
    }
    const priority = new Map([...this.desired.keys()].map((key, index) => [key, index]));
    const ordered = [...this.loaded.values()].toSorted((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      if (left.active && right.active) {
        const leftPriority = priority.get(left.cell.key) ?? Number.MAX_SAFE_INTEGER;
        const rightPriority = priority.get(right.cell.key) ?? Number.MAX_SAFE_INTEGER;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      }
      return right.lastUsedRevision - left.lastUsedRevision || left.cell.key.localeCompare(right.cell.key);
    });
    const keep = new Set<string>();
    let usedBytes = 0;
    for (const candidate of ordered) {
      if (usedBytes + candidate.bytes > this.memoryBudgetBytes) continue;
      usedBytes += candidate.bytes;
      keep.add(candidate.cell.key);
    }

    let evicted = false;
    for (const [key, loaded] of this.loaded) {
      if (keep.has(key)) continue;
      this.loaded.delete(key);
      if (loaded.primary) this.deactivateCell?.(loaded.resource, loaded.cell);
      this.releaseCell?.(loaded.resource, loaded.cell);
      if (loaded === incoming) {
        this.rejectedCells += 1;
        this.budgetDisposition = 'rejected-over-budget';
      } else {
        this.evictedCells += 1;
        evicted = true;
        if (loaded.active) this.failed.add(key);
      }
    }
    if (incoming && !keep.has(incoming.cell.key)) return false;
    this.budgetDisposition = evicted ? 'evicted' : 'within-budget';
    return true;
  }
}
