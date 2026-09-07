import { hashSeed } from './rng';
import { rendererAssetUrl } from './assetUrl';

export const UNIVERSAL_ACTOR_ATLAS_VERSION = '1.0.0' as const;
export const UNIVERSAL_ACTOR_ATLAS_URL =
  rendererAssetUrl('/assets/universal-materials/omnitwin-actor-atlas-v1.svg');
export const UNIVERSAL_ACTOR_ATLAS_WIDTH = 256 as const;
export const UNIVERSAL_ACTOR_ATLAS_HEIGHT = 128 as const;

export type UniversalActorKind = 'person' | 'vehicle';

export interface UniversalActorIconMappingEntry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly mask: false;
}

const PERSON_APPEARANCE_COUNT = 4;
const PERSON_GAIT_FRAME_COUNT = 2;
const VEHICLE_APPEARANCE_COUNT = 8;
const ICON_DEFINITION_SIZE = 7;

const mappingEntries: Array<readonly [string, UniversalActorIconMappingEntry]> = [];
for (let gaitFrame = 0; gaitFrame < PERSON_GAIT_FRAME_COUNT; gaitFrame += 1) {
  for (let appearance = 0; appearance < PERSON_APPEARANCE_COUNT; appearance += 1) {
    const slot = gaitFrame * PERSON_APPEARANCE_COUNT + appearance;
    mappingEntries.push([
      `person-${appearance}-walk-${gaitFrame}`,
      Object.freeze({
        x: slot * 32,
        y: 0,
        width: 32,
        height: 64,
        anchorX: 16,
        anchorY: 58,
        mask: false as const,
      }),
    ]);
  }
}
for (let appearance = 0; appearance < VEHICLE_APPEARANCE_COUNT; appearance += 1) {
  mappingEntries.push([
    `vehicle-${appearance}`,
    Object.freeze({
      x: appearance * 32,
      y: 64,
      width: 32,
      height: 32,
      anchorX: 16,
      anchorY: 16,
      mask: false as const,
    }),
  ]);
}

/** One source-independent, presentation-only atlas shared by both actor cohorts. */
export const UNIVERSAL_ACTOR_ICON_MAPPING: Readonly<
  Record<string, UniversalActorIconMappingEntry>
> = Object.freeze(Object.fromEntries(mappingEntries));

function iconDefinition(entry: UniversalActorIconMappingEntry): Float32Array {
  return new Float32Array([
    entry.width / 2 - entry.anchorX,
    entry.height / 2 - entry.anchorY,
    entry.x,
    entry.y,
    entry.width,
    entry.height,
    0,
  ]);
}

const PERSON_ICON_DEFINITIONS = Array.from(
  { length: PERSON_APPEARANCE_COUNT * PERSON_GAIT_FRAME_COUNT },
  (_, slot) => iconDefinition(
    UNIVERSAL_ACTOR_ICON_MAPPING[
      `person-${slot % PERSON_APPEARANCE_COUNT}-walk-${Math.floor(slot / PERSON_APPEARANCE_COUNT)}`
    ]!,
  ),
);
const VEHICLE_ICON_DEFINITIONS = Array.from(
  { length: VEHICLE_APPEARANCE_COUNT },
  (_, appearance) => iconDefinition(UNIVERSAL_ACTOR_ICON_MAPPING[`vehicle-${appearance}`]!),
);

export function universalActorSpriteKey(
  id: string,
  kind: UniversalActorKind,
  gaitFrame = 0,
): string {
  const hash = hashSeed(id);
  if (kind === 'vehicle') return `vehicle-${hash % VEHICLE_APPEARANCE_COUNT}`;
  const appearance = hash % PERSON_APPEARANCE_COUNT;
  const normalizedFrame = ((Math.floor(gaitFrame) % PERSON_GAIT_FRAME_COUNT)
    + PERSON_GAIT_FRAME_COUNT) % PERSON_GAIT_FRAME_COUNT;
  return `person-${appearance}-walk-${normalizedFrame}`;
}

/**
 * Writes Deck IconLayer's seven-value `instanceIconDefs` attribute in place.
 * The destination is retained across frames, so this performs no per-actor
 * object allocation and bypasses string accessors on the render hot path.
 */
export function writeUniversalActorIconDefinition(
  target: Float32Array,
  targetIndex: number,
  id: string,
  kind: UniversalActorKind,
  gaitFrame = 0,
): void {
  const hash = hashSeed(id);
  const definition = kind === 'vehicle'
    ? VEHICLE_ICON_DEFINITIONS[hash % VEHICLE_APPEARANCE_COUNT]!
    : PERSON_ICON_DEFINITIONS[
      (((Math.floor(gaitFrame) % PERSON_GAIT_FRAME_COUNT) + PERSON_GAIT_FRAME_COUNT)
        % PERSON_GAIT_FRAME_COUNT) * PERSON_APPEARANCE_COUNT
      + hash % PERSON_APPEARANCE_COUNT
    ]!;
  target.set(definition, targetIndex * ICON_DEFINITION_SIZE);
}

/** A low-cost visual stepping phase derived only from retained world position. */
export function universalActorGaitFrame(id: string, x: number, y: number): number {
  const phaseOffset = hashSeed(id) & 1;
  return (Math.floor(Math.abs(x * 0.71 + y * 0.43) * 1.6) + phaseOffset) & 1;
}
