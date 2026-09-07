import type { WorldViewportResponseV2 } from '@omnitwin/contracts';

export enum LivingPrimaryRenderer {
  NONE = 0,
  DECK = 1,
  THREE = 2,
}

export enum LivingLod {
  CULLED = 0,
  IMPOSTOR = 1,
  LOW = 2,
  DETAILED = 3,
  FOCUS = 4,
}

export enum LivingKind {
  PERSON = 0,
  VEHICLE = 1,
  FOCUS = 2,
}

export enum LivingRepresentation {
  FOCUS_1_TO_1 = 0,
  AGGREGATE_PROXY = 1,
  AMBIENT_ONLY = 2,
}

export enum LivingActivity {
  HOME = 0,
  WALK = 1,
  WORK = 2,
  TRANSIT = 3,
  LEISURE = 4,
  STUDY = 5,
}

export type LivingActivityScheduleDescriptor =
  WorldViewportResponseV2['visualSynthesis']['activityScheduling'];

export interface LivingActivityScheduleSoA {
  readonly descriptor: LivingActivityScheduleDescriptor;
  /** Deterministic profile 0..11; 255 means route-locked travel. */
  profile: Uint8Array;
}

export interface LivingDeviceCaps {
  maxPedestrians: number;
  maxVehicles: number;
  /** Near/detailed people are independently bounded from the total actor budget. */
  maxDetailedPedestrians: number;
  /** Near/detailed vehicles are independently bounded from the total actor budget. */
  maxDetailedVehicles: number;
  maxDetailed: number;
  maxLow: number;
  maxImpostors: number;
  maxChunkEntities: number;
}

export const DEFAULT_LIVING_DEVICE_CAPS: Readonly<LivingDeviceCaps> = {
  maxPedestrians: 10_000,
  maxVehicles: 2_000,
  maxDetailedPedestrians: 10_000,
  maxDetailedVehicles: 2_000,
  maxDetailed: 2_000,
  maxLow: 12_000,
  maxImpostors: 12_000,
  maxChunkEntities: 512,
};

export interface LivingIdentitySoA {
  /** Sparse immutable metadata; all hot-path numeric state is columnar below. */
  ids: readonly string[];
  idHash: Uint32Array;
  seed: Uint32Array;
  kind: Uint8Array;
  representation: Uint8Array;
  activity: Uint8Array;
  representedCount: Uint32Array;
  colorRgba: Uint32Array;
}

export interface LivingPositionSoA {
  baseX: Float32Array;
  baseY: Float32Array;
  previousX: Float32Array;
  previousY: Float32Array;
  currentX: Float32Array;
  currentY: Float32Array;
  previousHeading: Float32Array;
  currentHeading: Float32Array;
  baseHeading: Float32Array;
  speedMetersPerSecond: Float32Array;
}

export interface LivingMovementSoA {
  /** Index into the compiled graph routes, or -1 for a stationary entity. */
  routeIndex: Int32Array;
  /** Current compiled graph edge, or -1 when stationary. */
  currentEdgeIndex: Int32Array;
  /** Route-time seconds minus presentation epoch seconds; NaN uses benchmark seed phase. */
  routePhaseOffsetSeconds: Float64Array;
  routePhaseAnchorSeconds: Float64Array;
}

export interface LivingPresentationSoA {
  lod: Uint8Array;
  primaryRenderer: Uint8Array;
  visible: Uint8Array;
  screenSizePixels: Float32Array;
}

export interface LivingPartition {
  count: number;
  maxChunkEntities: number;
  originLongitude: number;
  originLatitude: number;
  identity: LivingIdentitySoA;
  /** Optional contract seam; dynamic activity itself belongs to each render frame. */
  activitySchedule: LivingActivityScheduleSoA | null;
  position: LivingPositionSoA;
  movement: LivingMovementSoA;
  movementGraph: import('./movementGraph').CompiledLivingMovementGraph | null;
  presentation: LivingPresentationSoA;
}

export interface LivingRenderFrame {
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array;
  activity: Uint8Array;
  alpha: number;
  simulationTick: number;
}

export interface LivingSimulation {
  partition: LivingPartition;
  tick: number;
  startPresentationTimeSeconds: number;
  presentationTimeSeconds: number;
  accumulatorSeconds: number;
  fixedStepCount: number;
  interpolationCount: number;
  reducedMotion: boolean;
}

export interface LivingConservation {
  logical: number;
  deck: number;
  three: number;
  culled: number;
  duplicatePrimary: number;
  representedLogical: number;
  representedDeck: number;
  representedThree: number;
  representedCulled: number;
}

export type LivingLodCounts = Record<'culled' | 'impostor' | 'low' | 'detailed' | 'focus', number>;

export interface LivingActivityCounts {
  home: number;
  walk: number;
  work: number;
  transit: number;
  leisure: number;
  study: number;
}

export interface LivingActivityQaSnapshot {
  /** Null only for the explicit legacy/no-schedule path. */
  descriptor: LivingActivityScheduleDescriptor | null;
  localHour: number | null;
  stableHash: string;
  counts: LivingActivityCounts;
}

export type LivingAvoidanceStatus = 'unavailable' | 'ready' | 'degraded';

export interface LivingQaSnapshot {
  logical: { total: number; pedestrians: number; vehicles: number };
  representation: { focus: number; aggregateProxy: number; ambientOnly: number };
  represented: { logical: number; deck: number; three: number; culled: number };
  primaryRenderer: { deck: number; three: number; culled: number; duplicates: number };
  lod: LivingLodCounts;
  activity: LivingActivityQaSnapshot;
  stablePositionHash: string;
  routeAdherenceViolations: number;
  routeDirectionViolations: number;
  avoidanceStatus: LivingAvoidanceStatus;
  avoidanceReason: string | null;
  simulationTick: number;
  fixedStepCount: number;
  interpolationCount: number;
  interpolationAlpha: number;
  presentationTimeSeconds: number;
}

export interface LivingActualAdapterSnapshot {
  /** Stable logical IDs actually submitted to each primary renderer. */
  deckIds: readonly string[];
  threeIds: readonly string[];
  /** Planned Deck rows intentionally omitted by camera cells or the device cap. */
  intentionalDeckOmissions?: number;
}

export interface LivingAdapterReconciliation {
  planned: { deck: number; three: number; culled: number };
  actual: { deck: number; three: number; unique: number };
  representedActual: { deck: number; three: number };
  duplicateActualIds: number;
  wrongPrimaryRenderer: number;
  missingVisibleIds: number;
  intentionalMissingVisibleIds: number;
  unaccountedMissingVisibleIds: number;
  intentionalOmissionMismatch: boolean;
  unexpectedOrCulledIds: number;
  exact: boolean;
}
