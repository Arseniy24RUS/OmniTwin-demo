import type { CompactPerson } from './index.mjs';
import type { BinaryInput, SourceRoad, SpatialTargets } from './spatial.mjs';

export const MOVEMENT_PAGE_SIZE: 8192;
export const MOVEMENT_CONTEXT_BYTES: 36;
export const MAX_MOVEMENT_PAGE_BYTES: number;
export const MAX_MOVEMENT_CELL_CONTEXT_BYTES: number;
export interface DemoMovementBuilding {
  index: number;
  id: string;
  center: [number, number];
  districtId: string | null;
  use: 'residential' | 'study' | 'work' | 'unknown';
}
export interface DemoMovementHousehold {
  householdIndex: number;
  members: [personIndex: number, raw16Base64: string][];
}
export interface DemoMovementPageInput {
  key: string;
  contexts: Uint8Array;
  households: DemoMovementHousehold[];
  buildings: DemoMovementBuilding[];
}
export interface DecodedMovementPage {
  contract: 'DemoMovementPageV2';
  key: string;
  count: number;
  buildings: DemoMovementBuilding[];
}
export interface DemoMovementContext {
  record: CompactPerson;
  homeBuildingIndex: number | null;
  targets: SpatialTargets;
  householdRecords: CompactPerson[];
  districtIndex: number | null;
}
export interface DemoMovementRoad extends SourceRoad {
  index: number;
  sourceRoadIndex: number;
  mode: 'walk' | 'car';
  connectivity: 'source_node_ids';
  semantics: 'connected_source_road_local_visual_synthesis_not_home_work_route';
}
export interface DemoMovementCellContext {
  contract: 'DemoMovementCellContextV2';
  key: string;
  bindings: [buildingIndex: number, walkIndex: number | null, carIndex: number | null][];
  roads: DemoMovementRoad[];
}
export interface DemoAsset {
  url: string;
  sha256: string;
  bytes: number;
  gzip?: { url: string; sha256: string; bytes: number };
}
export interface DemoMovementPageAsset extends DemoAsset {
  count: number;
  firstPersonIndex: number;
  lastPersonIndex: number;
}
export interface DemoMovementCell {
  key: string;
  bbox: [west: number, south: number, east: number, north: number];
  context: DemoAsset;
  pages: DemoMovementPageAsset[];
}
export interface DemoMovementIndexManifestV2 {
  contract: 'DemoMovementIndexManifestV2';
  datasetId: string;
  representation: 'visual_synthesis';
  scientificClaim: false;
  sourceHashes: {
    populationManifest: string;
    geographyManifest: string;
    spatialCodec: string;
    codec: string;
    [source: string]: string;
  };
  cellZoom: 16;
  pageSize: number;
  maxPageSize?: 8192;
  cells: DemoMovementCell[];
  [metadata: string]: unknown;
}
/** Throws with code MOVEMENT_PAGE_TOO_LARGE when the serialized page exceeds 8 MiB. */
export function encodeMovementPage(input: DemoMovementPageInput): Uint8Array;
export function decodeMovementPage(bytes: BinaryInput): DecodedMovementPage;
export function movementContextAt(decoded: DecodedMovementPage, ordinal: number): DemoMovementContext;
export function decodeMovementCellContext(bytes: BinaryInput): DemoMovementCellContext;
