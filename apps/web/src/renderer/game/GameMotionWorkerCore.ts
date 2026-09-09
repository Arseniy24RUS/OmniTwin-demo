import { ActorColumnsBridge } from './actorColumnsBridge';
import { buildActorRoadHints, createActorFootprintClearance, type ActorFootprintClearance } from './actorFootprintClearance';
import { LaneTraffic } from './laneTraffic';
import type { GameActorColumns } from './GameActors';
import { GAME_MOTION_LIMITS as LIMITS, GAME_MOTION_SOURCE_FIELDS, type GameMotionCost, type GameMotionRequest, type GameMotionResponse,
  type GameMotionSource, type GameMotionSourceDiagnostics, type GameMotionTimings } from './gameMotionProtocol';

const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item instanceof Set ? { setValues: [...item] } : item);
function sourceFingerprint(source: GameMotionSource): string {
  const pending: { value: unknown; depth: number }[] = [{ value: source, depth: 0 }];
  let values = 0, bytes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++values > LIMITS.sourceValues || depth > LIMITS.sourceDepth || bytes > LIMITS.sourceBytes) throw Error('Motion source exceeds its work budget');
    if (value === null || value === undefined || typeof value === 'boolean') { bytes += 4; continue; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw Error('Non-finite source number'); bytes += 8; continue; }
    if (typeof value === 'string') { if (value.length > LIMITS.stringLength) throw Error('Source string exceeds its budget'); bytes += value.length * 2 + 4; continue; }
    if (typeof value !== 'object') throw Error('Motion source must contain serializable data only');
    if (value instanceof Set) { for (const item of value) pending.push({ value: item, depth: depth + 1 }); }
    else if (Array.isArray(value)) { for (const item of value) pending.push({ value: item, depth: depth + 1 }); }
    else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw Error('Unsupported motion source object');
      for (const [key, item] of Object.entries(value)) { bytes += key.length * 2; pending.push({ value: item, depth: depth + 1 }); }
    }
    if (pending.length + values > LIMITS.sourceValues) throw Error('Motion source exceeds its value budget');
  }
  const array = (value: unknown, maximum: number) => Array.isArray(value) && value.length <= maximum;
  if (!source || !array(source.entities, LIMITS.actors) || !array(source.mobilityPresentationMovement, LIMITS.movementSources)
    || !array(source.gameSourceRoads, LIMITS.roads) || !array(source.gameSourceCorridors, LIMITS.corridors)
    || !source.origin || ![source.origin.longitude, source.origin.latitude, source.origin.altitude ?? 0, source.epochSeconds].every(Number.isFinite)
    || Math.abs(source.origin.longitude) > 180 || Math.abs(source.origin.latitude) >= 85.051129) throw Error('Invalid motion source envelope');
  const movement = source.presentationMovement;
  if (movement !== null && (!movement || !array(movement.nodes, LIMITS.nodes) || !array(movement.edges, LIMITS.edges) || !array(movement.routes, LIMITS.routes))) throw Error('Invalid movement graph envelope');
  if (source.verifiedCityBuildings !== null && !(source.verifiedCityBuildings?.canonicalIds instanceof Set)) throw Error('Verified canonical IDs must survive structured clone as a Set');
  if (source.verifiedCityBuildingBounds !== null && (!Array.isArray(source.verifiedCityBuildingBounds) || source.verifiedCityBuildingBounds.length !== 4)) throw Error('Invalid verified bounds envelope');
  const ids = new Set<string>();
  for (const entity of source.entities) {
    if (!entity || typeof entity.id !== 'string' || !entity.id || entity.id.length > 256 || ids.has(entity.id)
      || !['vehicle', 'person', 'focus'].includes(entity.kind) || ![entity.longitude, entity.latitude, entity.heading, entity.seed].every(Number.isFinite)
      || Math.abs(entity.longitude) > 180 || Math.abs(entity.latitude) >= 85.051129) throw Error('Invalid visual actor identity/position');
    ids.add(entity.id);
  }
  const fingerprint = json(source);
  if (fingerprint.length * 2 > LIMITS.sourceBytes) throw Error('Encoded motion source exceeds its byte budget');
  return fingerprint;
}

/** Own every outgoing buffer: transferring this object cannot detach the retained bridge. */
export function copyGameMotionColumns(columns: GameActorColumns): GameActorColumns {
  return { ...columns, ids: [...columns.ids], kinds: columns.kinds.slice(), seeds: columns.seeds.slice(),
    previousPositions: columns.previousPositions.slice(), nextPositions: columns.nextPositions.slice(),
    headings: columns.headings.slice(), walking: columns.walking.slice(),
    ...(columns.previousOpacities ? { previousOpacities: columns.previousOpacities.slice() } : {}),
    ...(columns.nextOpacities ? { nextOpacities: columns.nextOpacities.slice() } : {}),
    ...(columns.pickable ? { pickable: columns.pickable.slice() } : {}) };
}

/** One persistent solver, advanced only by explicit FIFO messages from the Scene. */
export class GameMotionWorkerCore {
  private generation = -1;
  private sourceRevision = -1;
  private sourceKey = '';
  private source: GameMotionSource | null = null;
  private guardKey = '';
  private coordinateKey = '';
  private laneTraffic = new LaneTraffic();
  private bridge: ActorColumnsBridge | null = null;
  private clearance: ActorFootprintClearance | null = null;
  private diagnostics: GameMotionSourceDiagnostics | null = null;
  private lastSampleTime: number | null = null;
  private failed = false;
  private disposed = false;
  private cost: GameMotionCost = { bridgeBuilds: 0, bridgeMaxMs: 0, guardBuilds: 0, guardMaxMs: 0,
    samples: 0, sampleMaxMs: 0, sourceValidationMaxMs: 0, copyMaxMs: 0 };
  private readonly now: () => number;
  private readonly includeFullProbe: boolean;
  constructor(options: { now?: () => number; includeFullProbe?: boolean } = {}) {
    this.now = options.now ?? (() => performance.now()); this.includeFullProbe = options.includeFullProbe === true;
  }

  private reset(generation: number): void {
    this.generation = generation; this.sourceRevision = -1; this.sourceKey = ''; this.source = null; this.guardKey = ''; this.coordinateKey = '';
    this.laneTraffic = new LaneTraffic(); this.bridge = null; this.clearance = null; this.diagnostics = null;
    this.lastSampleTime = null; this.failed = false;
  }

  handle(input: unknown): GameMotionResponse {
    const started = this.now(), message = input as GameMotionRequest;
    const requestId = integer(message?.requestId) ? message.requestId : -1;
    const generation = integer(message?.generation) ? message.generation : -1;
    const envelope = (timings: Omit<GameMotionTimings, 'totalMs'> = {}) => ({ requestId, generation,
      sourceRevision: this.sourceRevision, cost: { ...this.cost }, timings: { ...timings, totalMs: this.now() - started } });
    const reject = (code: string, detail: string): GameMotionResponse => ({ ...envelope(), type: 'rejected', code, message: detail });
    if (!message || requestId < 0 || generation < 0) return reject('invalid_message', 'Invalid motion request envelope');
    if (this.disposed) return reject('disposed', 'Motion worker is disposed');
    if (generation < this.generation) return reject('stale_generation', 'Motion request belongs to a previous context');
    if (message.type === 'dispose') { this.reset(generation); this.disposed = true; return { ...envelope(), type: 'disposed' }; }
    if (message.type === 'reset') { this.reset(generation); return { ...envelope(), type: 'reset' }; }
    if (message.type === 'configure') {
      if (!integer(message.sourceRevision)) return reject('invalid_source', 'Invalid source revision');
      if (generation === this.generation && message.sourceRevision < this.sourceRevision) return reject('stale_source_revision', 'Motion source revision is stale');
      let source: GameMotionSource;
      if ('sourcePatch' in message) {
        if ('source' in message || !message.sourcePatch || typeof message.sourcePatch !== 'object' || Array.isArray(message.sourcePatch)
          || Object.keys(message.sourcePatch).some(key => !(GAME_MOTION_SOURCE_FIELDS as readonly string[]).includes(key))) return reject('invalid_source_patch', 'Source patch contains unknown or conflicting fields');
        if (generation !== this.generation || !this.source) return reject('patch_base_missing', 'A new context requires a full source before patches');
        if (!integer(message.baseSourceRevision) || message.baseSourceRevision !== this.sourceRevision) return reject('patch_base_mismatch', 'Source patch must name the current acknowledged base');
        source = { ...this.source, ...message.sourcePatch };
      } else source = message.source;
      let fingerprint: string;
      try { fingerprint = sourceFingerprint(source); }
      catch (error) { return reject('invalid_source', error instanceof Error ? error.message : 'Invalid motion source'); }
      const validationMs = this.now() - started;
      this.cost.sourceValidationMaxMs = Math.max(this.cost.sourceValidationMaxMs, validationMs);
      if (generation > this.generation) this.reset(generation);
      if (this.failed) return reject('generation_failed', 'Failed solver requires an explicit context generation reset');
      if (message.sourceRevision === this.sourceRevision && fingerprint !== this.sourceKey) return reject('source_revision_conflict', 'A source revision cannot describe two payloads');
      if (this.bridge && fingerprint === this.sourceKey) {
        this.sourceRevision = message.sourceRevision; this.source = source;
        return { ...envelope({ validationMs }), type: 'configured', reused: true, diagnostics: structuredClone(this.diagnostics!) };
      }
      const coordinateKey = json([source.origin, source.epochSeconds]);
      if (this.bridge && coordinateKey !== this.coordinateKey) return reject('coordinate_context_changed', 'Origin/epoch changes require a new context generation');
      try {
        const nextGuardKey = json([source.verifiedCityBuildings, source.verifiedCityBuildingBounds, source.origin]);
        let guardMs = 0;
        if (nextGuardKey !== this.guardKey) {
          const start = this.now();
          this.clearance = source.verifiedCityBuildingBounds ? createActorFootprintClearance({ snapshot: source.verifiedCityBuildings,
            origin: source.origin, viewportBounds: source.verifiedCityBuildingBounds }) : null;
          guardMs = this.now() - start; this.guardKey = nextGuardKey;
          this.cost.guardBuilds++; this.cost.guardMaxMs = Math.max(this.cost.guardMaxMs, guardMs);
        }
        const hintStart = this.now();
        const hints = buildActorRoadHints(source.presentationMovement, source.gameSourceRoads, source.gameSourceCorridors);
        const roadHintsMs = this.now() - hintStart, bridgeStart = this.now();
        this.bridge = new ActorColumnsBridge(source.entities, source.presentationMovement, source.mobilityPresentationMovement,
          source.origin, source.epochSeconds, { laneTraffic: this.laneTraffic, sourceMetric: 'provider_equirectangular_111195',
            onceEndpointFadeMeters: 15, derivePairedSidewalks: Boolean(this.clearance), isPointClear: this.clearance?.isPointClear,
            roadHintsByEdgeId: hints });
        const bridgeMs = this.now() - bridgeStart;
        this.cost.bridgeBuilds++; this.cost.bridgeMaxMs = Math.max(this.cost.bridgeMaxMs, bridgeMs);
        const { offsets: _offsets, ...sidewalk } = this.bridge.sidewalkPreview;
        this.diagnostics = structuredClone({ actorCounts: { people: source.entities.filter(entity => entity.kind !== 'vehicle').length,
          vehicles: source.entities.filter(entity => entity.kind === 'vehicle').length }, motion: this.bridge.motionDiagnostics,
          sidewalk: { ...sidewalk, guardReady: Boolean(this.clearance), guard: this.clearance?.diagnostics ?? null,
            verifiedBounds: source.verifiedCityBuildingBounds }, vehicleLanes: this.bridge.vehicleLanePreview, traffic: this.bridge.trafficPresentation });
        this.coordinateKey = coordinateKey; this.sourceKey = fingerprint; this.source = source; this.sourceRevision = message.sourceRevision;
        return { ...envelope({ validationMs, guardMs, roadHintsMs, bridgeMs }), type: 'configured', reused: false,
          diagnostics: structuredClone(this.diagnostics) };
      } catch (error) {
        this.failed = true; this.bridge = null;
        return { ...envelope({ validationMs }), type: 'error', code: 'source_solver_failed',
          message: error instanceof Error ? error.message : 'Motion source preparation failed' };
      }
    }
    if (message.type !== 'sample' && message.type !== 'probe') return reject('invalid_message', 'Unknown motion request type');
    if (generation !== this.generation || !this.bridge || this.failed) return reject('not_configured', 'This motion generation has no valid source');
    if (message.sourceRevision !== this.sourceRevision) return reject('source_revision_mismatch', 'Sample source revision is not the configured revision');
    if (message.probeIds !== undefined && (!Array.isArray(message.probeIds) || message.probeIds.length > LIMITS.probeIds
      || message.probeIds.some(id => typeof id !== 'string' || !id || id.length > 256))) return reject('invalid_probe', 'Invalid bounded traffic probe IDs');
    if (message.type === 'probe') return { ...envelope(), type: 'probe', signals: structuredClone(this.laneTraffic.readSignals()),
      trafficProbe: structuredClone(this.laneTraffic.readProbe(message.probeIds)) };
    if (!Number.isFinite(message.timeSeconds) || !Number.isFinite(message.horizonSeconds)
      || message.horizonSeconds < 0 || message.horizonSeconds > LIMITS.horizonSeconds) return reject('invalid_sample', 'Invalid motion sample clock/window');
    if (this.lastSampleTime !== null && message.timeSeconds < this.lastSampleTime) return reject('clock_regression', 'A seek requires a new generation');
    if (this.lastSampleTime !== null && message.timeSeconds - this.lastSampleTime > LIMITS.clockAdvanceSeconds) return reject('clock_discontinuity', 'A discontinuous clock requires a new generation');
    try {
      const start = this.now(), retained = this.bridge.sample(message.timeSeconds, message.horizonSeconds), sampleMs = this.now() - start;
      const copyStart = this.now(), columns = copyGameMotionColumns(retained), signals = structuredClone(this.laneTraffic.readSignals());
      const trafficProbe = structuredClone(this.laneTraffic.readProbe(message.probeIds));
      let fullTrafficProbe: ReturnType<LaneTraffic['readProbe']> | undefined;
      const debugTimings: Pick<GameMotionTimings, 'fullProbeMs' | 'fullProbeJsonBytes' | 'fullProbeOmitted'> = {};
      if (this.includeFullProbe) {
        const debugStart = this.now(), full = this.laneTraffic.readProbeAllForDevelopment();
        const encoded = JSON.stringify(full), bytes = new TextEncoder().encode(encoded).byteLength;
        if (bytes <= 16 * 1024 * 1024) fullTrafficProbe = structuredClone(full);
        debugTimings.fullProbeJsonBytes = bytes; debugTimings.fullProbeOmitted = !fullTrafficProbe;
        debugTimings.fullProbeMs = this.now() - debugStart;
      }
      const copyMs = this.now() - copyStart;
      this.lastSampleTime = message.timeSeconds; this.cost.samples++;
      this.cost.sampleMaxMs = Math.max(this.cost.sampleMaxMs, sampleMs); this.cost.copyMaxMs = Math.max(this.cost.copyMaxMs, copyMs);
      return { ...envelope({ sampleMs, copyMs, ...debugTimings }), type: 'sample', timeSeconds: message.timeSeconds,
        horizonSeconds: message.horizonSeconds, columns, signals, trafficProbe, ...(fullTrafficProbe ? { fullTrafficProbe } : {}) };
    } catch (error) {
      this.failed = true; this.bridge = null;
      return { ...envelope(), type: 'error', code: 'sample_solver_failed', message: error instanceof Error ? error.message : 'Motion sampling failed' };
    }
  }
}
