import type { VisualEntity } from '../types';
import {
  createLivingPartition,
  previousLivingLodMap,
  type CreateLivingPartitionOptions,
} from './partition';
import {
  advanceLivingSimulation,
  createLivingSimulation,
  interpolateLivingSimulation,
  seekLivingSimulation,
  type AdvanceLivingSimulationOptions,
} from './simulation';
import { buildLivingSpatialIndex, pickLivingEntity, type LivingPickResult } from './spatial';
import { livingAdapterReconciliation, livingQaSnapshot } from './telemetry';
import {
  applyLivingLocalAvoidance,
  createUnavailableLivingLocalAvoidance,
  type LivingAvoidanceStatusReport,
  type LivingLocalAvoidanceAdapter,
} from './avoidance';
import type {
  LivingActualAdapterSnapshot,
  LivingAdapterReconciliation,
  LivingQaSnapshot,
  LivingRenderFrame,
  LivingSimulation,
} from './types';

export interface LivingWorldHooks {
  onFrame?: (frame: LivingRenderFrame) => void;
  onTelemetry?: (telemetry: LivingQaSnapshot) => void;
}

export interface LivingWorldSimulationOptions {
  presentationTimeSeconds?: number;
  reducedMotion?: boolean;
  localAvoidance?: LivingLocalAvoidanceAdapter;
}

export interface LivingWorldPipeline {
  replace: (
    entities: readonly VisualEntity[],
    options: CreateLivingPartitionOptions,
    simulationOptions?: LivingWorldSimulationOptions,
  ) => void;
  advance: (deltaSeconds: number, options?: AdvanceLivingSimulationOptions) => LivingRenderFrame;
  seek: (presentationTimeSeconds: number, reducedMotion?: boolean) => LivingRenderFrame;
  snapshot: () => LivingRenderFrame;
  telemetry: () => LivingQaSnapshot;
  pick: (x: number, y: number, radiusMeters: number) => LivingPickResult | null;
  simulation: () => LivingSimulation;
  avoidanceStatus: () => LivingAvoidanceStatusReport;
  reconcileAdapters: (actual: LivingActualAdapterSnapshot) => LivingAdapterReconciliation;
  dispose: () => void;
}

export function createLivingWorldPipeline(
  entities: readonly VisualEntity[],
  options: CreateLivingPartitionOptions,
  hooks: LivingWorldHooks = {},
  simulationOptions: LivingWorldSimulationOptions = {},
): LivingWorldPipeline {
  let localAvoidance = simulationOptions.localAvoidance ?? createUnavailableLivingLocalAvoidance();
  let simulation = createLivingSimulation(createLivingPartition(entities, options), simulationOptions);
  let avoidance = applyLivingLocalAvoidance(
    simulation.partition,
    interpolateLivingSimulation(simulation),
    localAvoidance,
    0,
  );
  let frame = avoidance.frame;
  let spatial = buildLivingSpatialIndex(simulation.partition, frame);
  let telemetrySnapshot = livingQaSnapshot(simulation, frame, avoidance.report);

  const refreshTelemetry = (full: boolean) => {
    if (full) telemetrySnapshot = livingQaSnapshot(simulation, frame, avoidance.report);
    else {
      telemetrySnapshot = {
        ...telemetrySnapshot,
        simulationTick: simulation.tick,
        fixedStepCount: simulation.fixedStepCount,
        interpolationCount: simulation.interpolationCount,
        interpolationAlpha: frame.alpha,
        presentationTimeSeconds: simulation.presentationTimeSeconds + simulation.accumulatorSeconds,
      };
    }
  };

  const publish = () => {
    hooks.onFrame?.(frame);
    hooks.onTelemetry?.(telemetrySnapshot);
  };

  return {
    replace(nextEntities, nextOptions, nextSimulationOptions = {}) {
      const previousLodById = previousLivingLodMap(simulation.partition);
      const presentationTimeSeconds = nextSimulationOptions.presentationTimeSeconds
        ?? simulation.presentationTimeSeconds + simulation.accumulatorSeconds;
      const nextAvoidance = nextSimulationOptions.localAvoidance ?? localAvoidance;
      if (nextAvoidance !== localAvoidance) localAvoidance.dispose?.();
      localAvoidance = nextAvoidance;
      simulation = createLivingSimulation(createLivingPartition(nextEntities, {
        ...nextOptions,
        previousLodById: nextOptions.previousLodById ?? previousLodById,
      }), {
        presentationTimeSeconds,
        reducedMotion: nextSimulationOptions.reducedMotion ?? simulation.reducedMotion,
      });
      avoidance = applyLivingLocalAvoidance(
        simulation.partition,
        interpolateLivingSimulation(simulation),
        localAvoidance,
        0,
      );
      frame = avoidance.frame;
      spatial = buildLivingSpatialIndex(simulation.partition, frame);
      refreshTelemetry(true);
      publish();
    },
    advance(deltaSeconds, advanceOptions) {
      const advance = advanceLivingSimulation(simulation, deltaSeconds, advanceOptions);
      avoidance = applyLivingLocalAvoidance(
        simulation.partition,
        interpolateLivingSimulation(simulation, frame),
        localAvoidance,
        deltaSeconds,
      );
      frame = avoidance.frame;
      if (advance.steps > 0) {
        spatial = buildLivingSpatialIndex(simulation.partition, frame);
        refreshTelemetry(true);
      } else refreshTelemetry(false);
      publish();
      return frame;
    },
    seek(presentationTimeSeconds, reducedMotion) {
      seekLivingSimulation(simulation, presentationTimeSeconds, { reducedMotion });
      avoidance = applyLivingLocalAvoidance(
        simulation.partition,
        interpolateLivingSimulation(simulation, frame),
        localAvoidance,
        0,
      );
      frame = avoidance.frame;
      spatial = buildLivingSpatialIndex(simulation.partition, frame);
      refreshTelemetry(true);
      publish();
      return frame;
    },
    snapshot() {
      return frame;
    },
    telemetry() {
      return telemetrySnapshot;
    },
    pick(x, y, radiusMeters) {
      return pickLivingEntity(spatial, x, y, radiusMeters);
    },
    simulation() {
      return simulation;
    },
    avoidanceStatus() {
      return avoidance.report;
    },
    reconcileAdapters(actual) {
      return livingAdapterReconciliation(simulation.partition, actual);
    },
    dispose() {
      localAvoidance.dispose?.();
    },
  };
}
