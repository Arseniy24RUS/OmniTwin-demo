import type { VisualEntity } from '../types';
import type { LivingSpatialChunk, LivingSpatialIndex } from './spatial';
import { writeLivingActivitiesAtPresentationSeconds } from './activitySchedule';
import {
  LivingPrimaryRenderer,
  LivingActivity,
  LivingKind,
  LivingRepresentation,
  type LivingPartition,
  type LivingActivityScheduleSoA,
  type LivingRenderFrame,
} from './types';

const METERS_PER_LATITUDE_DEGREE = 110_540;

function visualKind(kind: number): VisualEntity['kind'] {
  if (kind === LivingKind.VEHICLE) return 'vehicle';
  if (kind === LivingKind.FOCUS) return 'focus';
  return 'person';
}

function visualRepresentation(representation: number): VisualEntity['representation'] {
  if (representation === LivingRepresentation.FOCUS_1_TO_1) return 'focus_person_1to1';
  if (representation === LivingRepresentation.AMBIENT_ONLY) return 'ambient_only';
  return 'aggregate_proxy';
}

function visualActivity(activity: number): VisualEntity['activity'] {
  if (activity === LivingActivity.WALK) return 'walk';
  if (activity === LivingActivity.WORK) return 'work';
  if (activity === LivingActivity.STUDY) return 'study';
  if (activity === LivingActivity.TRANSIT) return 'transit';
  if (activity === LivingActivity.LEISURE) return 'leisure';
  return 'home';
}

function visualColor(colorRgba: number): string {
  return `#${(colorRgba >>> 8).toString(16).padStart(6, '0')}`;
}

function normalizedLongitude(longitude: number): number {
  return ((longitude + 540) % 360) - 180;
}

export interface LivingRendererBatch {
  key: string;
  indices: Uint32Array;
  frame: LivingRenderFrame;
  partition: LivingPartition;
}

export interface LivingRenderFramePair {
  previous: LivingRenderFrame;
  previousPresentationTimeSeconds: number;
  current: LivingRenderFrame;
  currentPresentationTimeSeconds: number;
}

export interface RetainedLivingEntityViews {
  readonly partition: LivingPartition;
  /** Allocated once per partition and mutated in place for subsequent frames. */
  readonly entities: VisualEntity[];
  readonly byId: Map<string, VisualEntity>;
  readonly indexById: ReadonlyMap<string, number>;
}

function assertLivingEntityViewFrame(partition: LivingPartition, frame: LivingRenderFrame): void {
  if (frame.x.length !== partition.count || frame.y.length !== partition.count
    || frame.heading.length !== partition.count || frame.activity.length !== partition.count) {
    throw new Error('Living entity-view frame buffers do not match the partition');
  }
}

function livingLongitudeMeters(partition: LivingPartition): number {
  return Math.max(
    1e-6,
    Math.cos((Math.max(-85, Math.min(85, partition.originLatitude)) * Math.PI) / 180)
      * 111_320,
  );
}

export function createRetainedLivingEntityViews(
  partition: LivingPartition,
  frame: LivingRenderFrame,
): RetainedLivingEntityViews {
  assertLivingEntityViewFrame(partition, frame);
  const longitudeMeters = livingLongitudeMeters(partition);
  const entities = new Array<VisualEntity>(partition.count);
  const byId = new Map<string, VisualEntity>();
  const indexById = new Map<string, number>();
  for (let index = 0; index < partition.count; index += 1) {
    const entity: VisualEntity = {
      id: partition.identity.ids[index]!,
      kind: visualKind(partition.identity.kind[index]!),
      representation: visualRepresentation(partition.identity.representation[index]!),
      longitude: normalizedLongitude(partition.originLongitude + frame.x[index]! / longitudeMeters),
      latitude: partition.originLatitude + frame.y[index]! / METERS_PER_LATITUDE_DEGREE,
      heading: frame.heading[index]!,
      representedCount: partition.identity.representedCount[index]!,
      activity: visualActivity(frame.activity[index]!),
      color: visualColor(partition.identity.colorRgba[index]!),
      seed: partition.identity.seed[index]!,
    };
    if (byId.has(entity.id)) throw new Error(`Living entity-view ID is duplicated: ${entity.id}`);
    entities[index] = entity;
    byId.set(entity.id, entity);
    indexById.set(entity.id, index);
  }
  return { partition, entities, byId, indexById };
}

function updateRetainedLivingEntityViewAtIndex(
  retained: RetainedLivingEntityViews,
  partition: LivingPartition,
  frame: LivingRenderFrame,
  index: number,
): VisualEntity {
  const id = partition.identity.ids[index]!;
  const entity = retained.entities[index];
  if (!entity || entity.id !== id || retained.byId.get(id) !== entity
    || retained.indexById.get(id) !== index) {
    throw new Error(`Living retained entity-view identity drifted at index ${index}`);
  }
  const longitudeMeters = livingLongitudeMeters(partition);
  entity.longitude = normalizedLongitude(
    partition.originLongitude + frame.x[index]! / longitudeMeters,
  );
  entity.latitude = partition.originLatitude
    + frame.y[index]! / METERS_PER_LATITUDE_DEGREE;
  entity.heading = frame.heading[index]!;
  entity.activity = visualActivity(frame.activity[index]!);
  return entity;
}

/** Updates one click/selection view without materializing the full actor cohort. */
export function updateRetainedLivingEntityView(
  retained: RetainedLivingEntityViews,
  partition: LivingPartition,
  frame: LivingRenderFrame,
  id: string,
): VisualEntity | null {
  assertLivingEntityViewFrame(partition, frame);
  if (retained.partition !== partition || retained.entities.length !== partition.count
    || retained.byId.size !== partition.count || retained.indexById.size !== partition.count) {
    throw new Error('Living retained entity views do not match the partition');
  }
  const index = retained.indexById.get(id);
  return index === undefined
    ? null
    : updateRetainedLivingEntityViewAtIndex(retained, partition, frame, index);
}

export function updateRetainedLivingEntityViews(
  retained: RetainedLivingEntityViews,
  partition: LivingPartition,
  frame: LivingRenderFrame,
): RetainedLivingEntityViews {
  assertLivingEntityViewFrame(partition, frame);
  if (retained.partition !== partition || retained.entities.length !== partition.count
    || retained.byId.size !== partition.count || retained.indexById.size !== partition.count) {
    throw new Error('Living retained entity views do not match the partition');
  }
  for (let index = 0; index < partition.count; index += 1) {
    updateRetainedLivingEntityViewAtIndex(retained, partition, frame, index);
  }
  return retained;
}

/** Allocates the reusable main-thread interpolation target exactly once. */
export function createLivingRenderFrameBuffer(count: number): LivingRenderFrame {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Living render-frame buffer count must be a non-negative safe integer');
  }
  return {
    x: new Float32Array(count),
    y: new Float32Array(count),
    heading: new Float32Array(count),
    activity: new Uint8Array(count),
    alpha: 0,
    simulationTick: 0,
  };
}

function interpolateHeading(previous: number, current: number, alpha: number): number {
  const delta = ((current - previous + 540) % 360) - 180;
  return (previous + delta * alpha + 360) % 360;
}

/**
 * Zero-allocation render interpolation for the latest two Worker SoA frames.
 * Runtime owns `output` and reuses it on every MapLibre rAF. The target is
 * clamped to the pair, so a late Worker never causes unbounded extrapolation.
 */
export function interpolateLivingRenderFramePair(
  pair: LivingRenderFramePair,
  targetPresentationTimeSeconds: number,
  output: LivingRenderFrame,
  activitySchedule: LivingActivityScheduleSoA | null = null,
): LivingRenderFrame {
  const count = pair.current.x.length;
  if (!Number.isFinite(pair.previousPresentationTimeSeconds)
    || !Number.isFinite(pair.currentPresentationTimeSeconds)
    || !(pair.currentPresentationTimeSeconds > pair.previousPresentationTimeSeconds)
    || !Number.isFinite(targetPresentationTimeSeconds)) {
    throw new Error('Living render-frame pair requires finite increasing presentation times');
  }
  if (pair.current.y.length !== count || pair.current.heading.length !== count
    || pair.current.activity.length !== count
    || pair.previous.x.length !== count || pair.previous.y.length !== count
    || pair.previous.heading.length !== count || pair.previous.activity.length !== count
    || output.x.length !== count || output.y.length !== count
    || output.heading.length !== count || output.activity.length !== count) {
    throw new Error('Living render-frame pair buffer lengths do not match');
  }
  if (activitySchedule && activitySchedule.profile.length !== count) {
    throw new Error('Living render-frame pair activity profile length does not match');
  }
  const alpha = Math.max(0, Math.min(1, (
    targetPresentationTimeSeconds - pair.previousPresentationTimeSeconds
  ) / (pair.currentPresentationTimeSeconds - pair.previousPresentationTimeSeconds)));
  for (let index = 0; index < count; index += 1) {
    output.x[index] = pair.previous.x[index]!
      + (pair.current.x[index]! - pair.previous.x[index]!) * alpha;
    output.y[index] = pair.previous.y[index]!
      + (pair.current.y[index]! - pair.previous.y[index]!) * alpha;
    output.heading[index] = interpolateHeading(
      pair.previous.heading[index]!,
      pair.current.heading[index]!,
      alpha,
    );
  }
  if (activitySchedule) {
    writeLivingActivitiesAtPresentationSeconds(
      activitySchedule.descriptor,
      activitySchedule.profile,
      targetPresentationTimeSeconds,
      output.activity,
    );
  } else {
    const categoricalFrame = targetPresentationTimeSeconds >= pair.currentPresentationTimeSeconds
      ? pair.current
      : pair.previous;
    output.activity.set(categoricalFrame.activity);
  }
  output.alpha = alpha;
  output.simulationTick = pair.current.simulationTick;
  return output;
}

export function livingRendererBatches(
  spatial: LivingSpatialIndex,
  renderer: 'deck' | 'three',
): readonly LivingRendererBatch[] {
  const code = renderer === 'deck' ? LivingPrimaryRenderer.DECK : LivingPrimaryRenderer.THREE;
  return spatial.chunks
    .filter((chunk: LivingSpatialChunk) => chunk.renderer === code)
    .map((chunk) => ({
      key: chunk.key,
      indices: chunk.indices,
      frame: spatial.frame,
      partition: spatial.partition,
    }));
}

/** Compatibility adapter for existing object-based adapters; not a hot-path representation. */
export function livingFrameToVisualEntities(
  partition: LivingPartition,
  frame: LivingRenderFrame,
  renderer?: 'deck' | 'three',
): VisualEntity[] {
  const longitudeMeters = Math.cos((partition.originLatitude * Math.PI) / 180) * 111_320;
  const rendererCode = renderer === undefined
    ? undefined
    : renderer === 'deck' ? LivingPrimaryRenderer.DECK : LivingPrimaryRenderer.THREE;
  const output: VisualEntity[] = [];
  for (let index = 0; index < partition.count; index += 1) {
    if (rendererCode !== undefined && partition.presentation.primaryRenderer[index] !== rendererCode) continue;
    if (partition.presentation.primaryRenderer[index] === LivingPrimaryRenderer.NONE) continue;
    output.push({
      id: partition.identity.ids[index]!,
      kind: visualKind(partition.identity.kind[index]!),
      representation: visualRepresentation(partition.identity.representation[index]!),
      longitude: normalizedLongitude(partition.originLongitude + frame.x[index]! / longitudeMeters),
      latitude: partition.originLatitude + frame.y[index]! / METERS_PER_LATITUDE_DEGREE,
      heading: frame.heading[index]!,
      representedCount: partition.identity.representedCount[index]!,
      activity: visualActivity(frame.activity[index]!),
      color: visualColor(partition.identity.colorRgba[index]!),
      seed: partition.identity.seed[index]!,
    });
  }
  return output;
}
