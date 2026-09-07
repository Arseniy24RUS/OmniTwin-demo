export const LIVING_CAMERA_CELL_ZOOM = 16 as const;
export const LIVING_INDIVIDUAL_DETAIL_MIN_ZOOM = 15.5 as const;

export type LivingDetailMode = 'aggregate' | 'individual';

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const MAX_ENUMERATED_CAMERA_CELLS = 16_384;

/** Identity-bearing z16 cells are never selected for the general-plan view. */
export function livingDetailModeForZoom(zoom: number): LivingDetailMode {
  return Number.isFinite(zoom) && zoom >= LIVING_INDIVIDUAL_DETAIL_MIN_ZOOM
    ? 'individual'
    : 'aggregate';
}

export interface LivingCameraBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface LivingCameraCell {
  readonly z: typeof LIVING_CAMERA_CELL_ZOOM;
  readonly x: number;
  readonly y: number;
  readonly code: number;
  readonly key: string;
}

export interface LivingCameraCellSelection {
  readonly cells: readonly LivingCameraCell[];
  readonly cellCodes: readonly number[];
  readonly cellKeys: readonly string[];
  /** True only when a pathological wide view exceeded the bounded enumeration budget. */
  readonly overflowed: boolean;
  /** Canonical set identity; unchanged while the guarded tile set is unchanged. */
  readonly key: string;
}

export interface LivingCameraCellDiff {
  readonly changed: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly key: string;
}

/**
 * Constant-time signature for the guarded z16 extent. Camera move events can
 * compare this before allocating/sorting the concrete cell set.
 */
export function livingCameraCellExtentKey(
  bounds: LivingCameraBounds,
  guardCells = 1,
): string {
  const values = [bounds.west, bounds.south, bounds.east, bounds.north];
  if (!values.every(Number.isFinite)) return '';
  const tileCount = 2 ** LIVING_CAMERA_CELL_ZOOM;
  const guard = Math.max(0, Math.floor(Number.isFinite(guardCells) ? guardCells : 0));
  const south = Math.min(bounds.south, bounds.north);
  const north = Math.max(bounds.south, bounds.north);
  let west = bounds.west;
  let east = bounds.east;
  if (east < west) east += Math.ceil((west - east) / 360) * 360;
  if (east - west >= 360) {
    west = -180;
    east = 180 - 1e-9;
  }
  const rawWest = tileX(west, tileCount) - guard;
  const rawEast = tileX(east, tileCount) + guard;
  const northY = clampTileY(tileY(north, tileCount) - guard, tileCount);
  const southY = clampTileY(tileY(south, tileCount) + guard, tileCount);
  const xCount = Math.min(tileCount, Math.max(0, rawEast - rawWest + 1));
  const yCount = Math.max(0, southY - northY + 1);
  if (xCount * yCount > MAX_ENUMERATED_CAMERA_CELLS) return 'overflow';
  return [
    guard,
    wrapTileX(rawWest, tileCount),
    xCount,
    northY,
    southY,
  ].join(':');
}

function wrapTileX(x: number, tileCount: number): number {
  return ((x % tileCount) + tileCount) % tileCount;
}

function clampTileY(y: number, tileCount: number): number {
  return Math.max(0, Math.min(tileCount - 1, y));
}

function tileX(longitude: number, tileCount: number): number {
  return Math.floor(((longitude + 180) / 360) * tileCount);
}

function tileY(latitude: number, tileCount: number): number {
  const clamped = Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, latitude),
  );
  const radians = (clamped * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2)
      * tileCount,
  );
}

function cell(x: number, y: number): LivingCameraCell {
  return {
    z: LIVING_CAMERA_CELL_ZOOM,
    x,
    y,
    code: y * (2 ** LIVING_CAMERA_CELL_ZOOM) + x,
    key: `${LIVING_CAMERA_CELL_ZOOM}/${x}/${y}`,
  };
}

export function livingCameraCellForCoordinate(
  longitude: number,
  latitude: number,
): LivingCameraCell | null {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
    || latitude < -WEB_MERCATOR_MAX_LATITUDE
    || latitude > WEB_MERCATOR_MAX_LATITUDE) return null;
  const tileCount = 2 ** LIVING_CAMERA_CELL_ZOOM;
  return cell(
    wrapTileX(tileX(longitude, tileCount), tileCount),
    clampTileY(tileY(latitude, tileCount), tileCount),
  );
}

export function livingCameraCellCodeForCoordinate(
  longitude: number,
  latitude: number,
): number | null {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
    || latitude < -WEB_MERCATOR_MAX_LATITUDE
    || latitude > WEB_MERCATOR_MAX_LATITUDE) return null;
  const tileCount = 2 ** LIVING_CAMERA_CELL_ZOOM;
  const x = wrapTileX(tileX(longitude, tileCount), tileCount);
  const y = clampTileY(tileY(latitude, tileCount), tileCount);
  return y * tileCount + x;
}

/** Enumerates z16 cells intersecting the viewport plus an integer guard ring. */
export function selectLivingCameraCells(
  bounds: LivingCameraBounds,
  guardCells = 1,
): LivingCameraCellSelection {
  const values = [bounds.west, bounds.south, bounds.east, bounds.north];
  if (!values.every(Number.isFinite)) {
    return { cells: [], cellCodes: [], cellKeys: [], overflowed: false, key: '' };
  }
  const tileCount = 2 ** LIVING_CAMERA_CELL_ZOOM;
  const guard = Math.max(0, Math.floor(Number.isFinite(guardCells) ? guardCells : 0));
  const south = Math.min(bounds.south, bounds.north);
  const north = Math.max(bounds.south, bounds.north);
  let west = bounds.west;
  let east = bounds.east;
  if (east < west) east += Math.ceil((west - east) / 360) * 360;
  if (east - west >= 360) {
    west = -180;
    east = 180 - 1e-9;
  }

  const rawWest = tileX(west, tileCount) - guard;
  const rawEast = tileX(east, tileCount) + guard;
  const northY = clampTileY(tileY(north, tileCount) - guard, tileCount);
  const southY = clampTileY(tileY(south, tileCount) + guard, tileCount);
  const xCount = Math.min(tileCount, Math.max(0, rawEast - rawWest + 1));
  const yCount = Math.max(0, southY - northY + 1);
  if (xCount * yCount > MAX_ENUMERATED_CAMERA_CELLS) {
    const key = 'overflow';
    return { cells: [], cellCodes: [], cellKeys: [], overflowed: true, key };
  }
  const selected = new Map<string, LivingCameraCell>();

  for (let y = northY; y <= southY; y += 1) {
    for (let rawX = rawWest; rawX <= rawEast; rawX += 1) {
      const x = wrapTileX(rawX, tileCount);
      const candidate = cell(x, y);
      selected.set(candidate.key, candidate);
    }
  }

  const cells = [...selected.values()].toSorted((left, right) =>
    left.y - right.y || left.x - right.x);
  const cellKeys = cells.map((candidate) => candidate.key);
  const cellCodes = cells.map((candidate) => candidate.code);
  return { cells, cellCodes, cellKeys, overflowed: false, key: cellKeys.join('|') };
}

export function diffLivingCameraCells(
  previous: LivingCameraCellSelection | null | undefined,
  next: LivingCameraCellSelection,
): LivingCameraCellDiff {
  if (previous?.key === next.key) {
    return { changed: false, added: [], removed: [], key: next.key };
  }
  const previousKeys = new Set(previous?.cellKeys ?? []);
  const nextKeys = new Set(next.cellKeys);
  return {
    changed: true,
    added: next.cellKeys.filter((key) => !previousKeys.has(key)),
    removed: [...previousKeys].filter((key) => !nextKeys.has(key)).toSorted(),
    key: next.key,
  };
}
