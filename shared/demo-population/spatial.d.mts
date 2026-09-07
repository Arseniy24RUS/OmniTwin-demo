import type { CompactPerson, Scenario } from './index.mjs';

export const SPATIAL_NONE: number;
export const TARGET_RECORD_BYTES: 12;
export const BUILDING_ROLE_SHARD_SIZE: 256;
export const MAX_CELL_CANDIDATES: 256;
export type SpatialRole = 'home' | 'work' | 'study' | 'visitor';
export const SPATIAL_ROLES: readonly SpatialRole[];
export interface SpatialTargets { workBuildingIndex: number | null; studyBuildingIndex: number | null; visitorBuildingIndex: number | null }
export interface SpatialShard { bytes: Uint8Array; view: DataView; startIndex: number; count: number; stride: number; extra: number }
export interface RoleShard extends SpatialShard { memberStart: number }
export interface RosterContexts { bytes: Uint8Array; view: DataView; count: number }
export type BinaryInput = ArrayBuffer | ArrayBufferView;
export interface SourceRoad { index?: number; id: string; coordinates: readonly (readonly number[])[]; oneway: boolean; walkable: boolean; drivable: boolean; closed?: boolean; segments?: readonly { fromNodeId: string; toNodeId: string | null }[] }
export interface SpatialPresence {
  active: boolean;
  role: SpatialRole | 'unplaced' | 'travel' | 'leisure' | null;
  buildingIndex: number | null;
  originBuildingIndex?: number;
  destinationBuildingIndex?: number;
  progress?: number;
  direction?: 'outbound' | 'return';
  tripPurpose?: 'local_source_road_outing' | 'shared_household_source_road_outing';
  age?: number;
  vehicleDriverIndex?: number; vehicleId?: string; passengerIndices?: number[];
}
export interface DailyMovement {
  longitude: number; latitude: number; heading: number; routeId: string; progress: number;
  mode: 'vehicle' | 'pedestrian'; vehicleId: string | null;
  direction: 'forward' | 'reverse'; speedMps: number;
  routeMode: 'ping_pong' | 'loop' | 'once'; endpointOpacity: number;
  semantics: 'source_polyline_presentation_not_commute_corridor';
}
export function encodeTargetShard(startIndex: number, values: Uint32Array, buildingCount: number): Uint8Array;
export function decodeTargetShard(value: BinaryInput): SpatialShard;
export function targetAt(shard: SpatialShard, personIndex: number): SpatialTargets;
export function encodeRoleShard(startBuildingIndex: number, buildingCount: number, offsets: Uint32Array, members: Uint32Array, personCount: number): Uint8Array;
export function decodeRoleShard(value: BinaryInput): RoleShard;
export function roleMembers(shard: RoleShard, buildingIndex: number, role: SpatialRole, options?: { offset?: number; limit?: number }): { members: number[]; total: number; nextOffset: number | null };
export function decodeEmbeddedPerson(personIndex: number, value: string | BinaryInput): CompactPerson;
export function decodeRosterContexts(value: BinaryInput): RosterContexts;
export function rosterContextAt(shard: RosterContexts, ordinal: number): { record: CompactPerson; homeBuildingIndex: number | null; targets: SpatialTargets };
export interface HouseholdTrip { householdIndex: number; driverPersonIndex: number; passengerIndices: number[]; vehicleId: string; startMinute: number; endMinute: number }
export interface HouseholdTripMasks { bytes: Uint8Array; count: number }
export function householdHasVehicle(householdIndex: number): boolean;
export function householdTripFor(householdRecords: CompactPerson[], year: number, scenario: Scenario): HouseholdTrip | null;
export function decodeHouseholdTripMasks(value: BinaryInput): HouseholdTripMasks;
export function householdTripParticipantAt(shard: HouseholdTripMasks, ordinal: number, year: number, scenario: Scenario): boolean;
export function potentialRoles(record: CompactPerson): { work: boolean; study: boolean };
export function activeTargets(record: CompactPerson, targets: SpatialTargets, year: number, scenario: Scenario): SpatialTargets;
export function visitorEligible(building: { use?: string; sourceAttributes?: Record<string, unknown> }): boolean;
export interface DestinationPool { buildings: number[]; cumulative: number[]; total: number }
export function buildDestinationPools(rows: unknown[][]): Map<string, DestinationPool>;
export function selectDestination(pools: Map<string, DestinationPool>, districtId: string | null, role: 'work' | 'study' | 'visitor', personIndex: number, seed?: number): number | null;
export function spatialCellKey(lon: number, lat: number, zoom?: number): string;
export function presenceFor(record: CompactPerson, targets: SpatialTargets, homeBuildingIndex: number | null, year: number, scenario: Scenario, minutes: number, context?: { householdRecords?: CompactPerson[]; householdTripParticipant?: boolean }): SpatialPresence;
export function dailyMovement(record: CompactPerson, presence: SpatialPresence, roads: { walkRoad?: SourceRoad | null; carRoad?: SourceRoad | null } | undefined, minutes: number): DailyMovement | null;
