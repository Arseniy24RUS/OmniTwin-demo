import type { CityRoadV2 } from '../../demo/data/CityPackV2';
import type { LivingSceneMovementEntitySource } from '../living/sceneMovement';
import type { VisualEntity, WorldSceneMovementPayload } from '../types';
import type { VerifiedCityBuildingSnapshot } from '../verifiedCityBuildingTypes';
import type { ActorColumnsBridge } from './actorColumnsBridge';
import type { ActorFootprintClearance, ActorSourceCorridor } from './actorFootprintClearance';
import type { GameOrigin } from './cameraAdapter';
import type { GameActorColumns } from './GameActors';
import type { LaneTraffic } from './laneTraffic';

/** Source geometry and IDs only; no GPU handles, callbacks or independently running clock. */
export interface GameMotionSource {
  entities: readonly VisualEntity[];
  presentationMovement: WorldSceneMovementPayload | null;
  mobilityPresentationMovement: readonly LivingSceneMovementEntitySource[];
  /** ReadonlySet survives native structured clone; its source identity is retained. */
  verifiedCityBuildings: VerifiedCityBuildingSnapshot | null;
  verifiedCityBuildingBounds: readonly [number, number, number, number] | null;
  gameSourceRoads: readonly CityRoadV2[];
  gameSourceCorridors: readonly ActorSourceCorridor[];
  origin: GameOrigin;
  epochSeconds: number;
}
interface Envelope { requestId: number; generation: number }
export type GameMotionSourcePatch = Partial<GameMotionSource>;
export type GameMotionConfigureRequest = Envelope & { type: 'configure'; sourceRevision: number } & (
  | { source: GameMotionSource; baseSourceRevision?: never; sourcePatch?: never }
  | { source?: never; baseSourceRevision: number; sourcePatch: GameMotionSourcePatch });
export type GameMotionRequest =
  | GameMotionConfigureRequest
  | (Envelope & { type: 'sample'; sourceRevision: number; timeSeconds: number; horizonSeconds: number; probeIds?: readonly string[] })
  | (Envelope & { type: 'probe'; sourceRevision: number; probeIds?: readonly string[] })
  | (Envelope & { type: 'reset' | 'dispose' });

export interface GameMotionCost {
  bridgeBuilds: number; bridgeMaxMs: number; guardBuilds: number; guardMaxMs: number;
  samples: number; sampleMaxMs: number; sourceValidationMaxMs: number; copyMaxMs: number;
}
export interface GameMotionTimings {
  totalMs: number; validationMs?: number; guardMs?: number; roadHintsMs?: number;
  bridgeMs?: number; sampleMs?: number; copyMs?: number;
  fullProbeMs?: number; fullProbeJsonBytes?: number; fullProbeOmitted?: boolean;
}
export interface GameMotionSourceDiagnostics {
  actorCounts: { people: number; vehicles: number };
  motion: ActorColumnsBridge['motionDiagnostics'];
  sidewalk: Omit<ActorColumnsBridge['sidewalkPreview'], 'offsets'> & {
    guardReady: boolean; guard: ActorFootprintClearance['diagnostics'] | null;
    verifiedBounds: GameMotionSource['verifiedCityBuildingBounds'];
  };
  vehicleLanes: ActorColumnsBridge['vehicleLanePreview'];
  traffic: ActorColumnsBridge['trafficPresentation'];
}
export type GameMotionSignals = ReturnType<LaneTraffic['readSignals']>;
export type GameMotionTrafficProbe = ReturnType<LaneTraffic['readProbe']>;
interface ResponseEnvelope extends Envelope { sourceRevision: number; cost: GameMotionCost; timings: GameMotionTimings }
export type GameMotionResponse =
  | (ResponseEnvelope & { type: 'configured'; reused: boolean; diagnostics: GameMotionSourceDiagnostics })
  | (ResponseEnvelope & { type: 'sample'; timeSeconds: number; horizonSeconds: number;
      columns: GameActorColumns; signals: GameMotionSignals; trafficProbe: GameMotionTrafficProbe;
      /** DEV only: owned snapshot of this exact sample, never a future worker query. */
      fullTrafficProbe?: GameMotionTrafficProbe })
  | (ResponseEnvelope & { type: 'probe'; signals: GameMotionSignals; trafficProbe: GameMotionTrafficProbe })
  | (ResponseEnvelope & { type: 'reset' | 'disposed' })
  | (ResponseEnvelope & { type: 'rejected' | 'error'; code: string; message: string });

export const GAME_MOTION_LIMITS = Object.freeze({ actors: 4096, movementSources: 20_000, roads: 20_000,
  corridors: 20_000, edges: 20_000, nodes: 40_000, routes: 20_000, probeIds: 64,
  sourceBytes: 32 * 1024 * 1024, sourceValues: 2_000_000, sourceDepth: 32, stringLength: 1_048_576,
  horizonSeconds: 2, clockAdvanceSeconds: 30 });
export const GAME_MOTION_SOURCE_FIELDS = Object.freeze(['entities', 'presentationMovement', 'mobilityPresentationMovement',
  'verifiedCityBuildings', 'verifiedCityBuildingBounds', 'gameSourceRoads', 'gameSourceCorridors', 'origin', 'epochSeconds'] as const);

/** Transfer only the detached output copy. The retained bridge never owns these buffers. */
export function gameMotionTransferables(response: GameMotionResponse): ArrayBuffer[] {
  if (response.type !== 'sample') return [];
  const c = response.columns;
  return [...new Set([c.kinds, c.seeds, c.previousPositions, c.nextPositions, c.previousOpacities,
    c.nextOpacities, c.headings, c.walking, c.pickable].filter((value): value is NonNullable<typeof value> => Boolean(value))
    .map(value => value.buffer as ArrayBuffer))];
}
