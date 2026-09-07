import {
  LivingLod,
  LivingPrimaryRenderer,
  type LivingPartition,
  type LivingRenderFrame,
} from './types';

export interface LivingSpatialChunk {
  key: string;
  cellX: number;
  cellY: number;
  renderer: LivingPrimaryRenderer.DECK | LivingPrimaryRenderer.THREE;
  lod: LivingLod;
  indices: Uint32Array;
}

export interface LivingSpatialIndex {
  partition: LivingPartition;
  frame: LivingRenderFrame;
  cellSizeMeters: number;
  chunks: readonly LivingSpatialChunk[];
  cells: ReadonlyMap<string, Uint32Array>;
}

export interface BuildLivingSpatialIndexOptions {
  cellSizeMeters?: number;
  maxChunkEntities?: number;
}

export interface LivingPickResult {
  id: string;
  index: number;
  distanceMeters: number;
}

function cellKey(cellX: number, cellY: number): string {
  return `${cellX}:${cellY}`;
}

function chunkKey(
  renderer: LivingPrimaryRenderer,
  lod: LivingLod,
  cellX: number,
  cellY: number,
): string {
  return `${renderer}:${lod}:${cellX}:${cellY}`;
}

export function buildLivingSpatialIndex(
  partition: LivingPartition,
  frame: LivingRenderFrame,
  options: BuildLivingSpatialIndexOptions = {},
): LivingSpatialIndex {
  const cellSizeMeters = Math.max(1, options.cellSizeMeters ?? 128);
  const maxChunkEntities = Math.max(1, Math.floor(
    options.maxChunkEntities ?? partition.maxChunkEntities,
  ));
  const cellLists = new Map<string, number[]>();
  const chunkLists = new Map<string, {
    cellX: number;
    cellY: number;
    renderer: LivingPrimaryRenderer.DECK | LivingPrimaryRenderer.THREE;
    lod: LivingLod;
    indices: number[];
  }>();

  for (let index = 0; index < partition.count; index += 1) {
    const renderer = partition.presentation.primaryRenderer[index];
    if (renderer !== LivingPrimaryRenderer.DECK && renderer !== LivingPrimaryRenderer.THREE) continue;
    const cellX = Math.floor(frame.x[index]! / cellSizeMeters);
    const cellY = Math.floor(frame.y[index]! / cellSizeMeters);
    const spatialKey = cellKey(cellX, cellY);
    const existingCell = cellLists.get(spatialKey);
    if (existingCell) existingCell.push(index);
    else cellLists.set(spatialKey, [index]);
    const lod = partition.presentation.lod[index] as LivingLod;
    const groupKey = chunkKey(renderer, lod, cellX, cellY);
    const existingChunk = chunkLists.get(groupKey);
    if (existingChunk) existingChunk.indices.push(index);
    else chunkLists.set(groupKey, {
      cellX,
      cellY,
      renderer,
      lod,
      indices: [index],
    });
  }

  const chunks: LivingSpatialChunk[] = [];
  for (const [key, group] of [...chunkLists.entries()].toSorted(([left], [right]) => left.localeCompare(right))) {
    for (let offset = 0; offset < group.indices.length; offset += maxChunkEntities) {
      chunks.push({
        key: `${key}:${Math.floor(offset / maxChunkEntities)}`,
        cellX: group.cellX,
        cellY: group.cellY,
        renderer: group.renderer,
        lod: group.lod,
        indices: Uint32Array.from(group.indices.slice(offset, offset + maxChunkEntities)),
      });
    }
  }
  const cells = new Map<string, Uint32Array>();
  for (const [key, indices] of cellLists) cells.set(key, Uint32Array.from(indices));
  return { partition, frame, cellSizeMeters, chunks, cells };
}

export function pickLivingEntity(
  spatial: LivingSpatialIndex,
  x: number,
  y: number,
  radiusMeters: number,
): LivingPickResult | null {
  const radius = Math.max(0, radiusMeters);
  const minimumCellX = Math.floor((x - radius) / spatial.cellSizeMeters);
  const maximumCellX = Math.floor((x + radius) / spatial.cellSizeMeters);
  const minimumCellY = Math.floor((y - radius) / spatial.cellSizeMeters);
  const maximumCellY = Math.floor((y + radius) / spatial.cellSizeMeters);
  let nearestIndex = -1;
  let nearestSquared = radius * radius;
  for (let cellX = minimumCellX; cellX <= maximumCellX; cellX += 1) {
    for (let cellY = minimumCellY; cellY <= maximumCellY; cellY += 1) {
      const indices = spatial.cells.get(cellKey(cellX, cellY));
      if (!indices) continue;
      for (const index of indices) {
        const dx = spatial.frame.x[index]! - x;
        const dy = spatial.frame.y[index]! - y;
        const squared = dx * dx + dy * dy;
        const tie = squared === nearestSquared
          && nearestIndex >= 0
          && spatial.partition.identity.idHash[index]! < spatial.partition.identity.idHash[nearestIndex]!;
        if (squared < nearestSquared || tie || (squared === 0 && nearestIndex < 0)) {
          nearestSquared = squared;
          nearestIndex = index;
        }
      }
    }
  }
  if (nearestIndex < 0) return null;
  return {
    id: spatial.partition.identity.ids[nearestIndex]!,
    index: nearestIndex,
    distanceMeters: Math.sqrt(nearestSquared),
  };
}
