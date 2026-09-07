import { createDeterministicRng, deterministicBetween, hashSeed } from './rng';
import type { VisualEntity, VisualRepresentation } from './types';
import type { RendererQuality } from './types';

export type SemanticLevelId = 'country' | 'subject' | 'city' | 'district' | 'agent';

export interface LodProfile {
  level: SemanticLevelId;
  people: number;
  vehicles: number;
  personRepresentation: VisualRepresentation;
  averageRepresentedCount: number;
}

const ACTIVITIES: readonly VisualEntity['activity'][] = [
  'home',
  'walk',
  'work',
  'transit',
  'leisure',
];

const SPREAD_BY_LEVEL: Record<SemanticLevelId, readonly [number, number]> = {
  country: [36, 15],
  subject: [5.8, 3.4],
  city: [0.34, 0.2],
  district: [0.065, 0.04],
  agent: [0.014, 0.008],
};

/** Product cap for all dynamic visual instances submitted to GPU adapters. */
export function dynamicInstanceCap(quality: RendererQuality): number {
  return quality === 'cinematic' || quality === 'adaptive' ? 12_000 : 5_000;
}

export function semanticLevelForZoom(zoom: number): SemanticLevelId {
  if (zoom < 5) return 'country';
  if (zoom < 9) return 'subject';
  if (zoom < 12.5) return 'city';
  if (zoom < 17.2) return 'district';
  return 'agent';
}

export function getLodProfile(zoom: number, entityCap = 3_600): LodProfile {
  const level = semanticLevelForZoom(zoom);
  const raw = {
    country: { people: 160, vehicles: 0, averageRepresentedCount: 25_000 },
    subject: { people: 300, vehicles: 24, averageRepresentedCount: 11_000 },
    city: { people: 720, vehicles: 120, averageRepresentedCount: 850 },
    district: { people: 1_600, vehicles: 320, averageRepresentedCount: 95 },
    agent: { people: 2_800, vehicles: 560, averageRepresentedCount: 18 },
  }[level];
  const total = raw.people + raw.vehicles;
  const scale = total > entityCap ? entityCap / total : 1;
  const people = Math.max(1, Math.floor(raw.people * scale));
  const vehicles = Math.max(0, Math.floor(raw.vehicles * scale));
  return {
    level,
    people,
    vehicles,
    personRepresentation: 'aggregate_proxy',
    averageRepresentedCount: raw.averageRepresentedCount,
  };
}

export interface GenerateEntitiesOptions {
  zoom: number;
  seed?: string;
  cap?: number;
  /** Explicit scene center resolved from the active bundle; never a product default. */
  center: readonly [number, number] | undefined;
}

export interface GeneratePerformanceEntitiesOptions {
  zoom?: number;
  seed?: string;
  pedestrianCount?: number;
  vehicleCount?: number;
  center?: readonly [number, number];
}

interface BuildEntitiesOptions {
  level: SemanticLevelId;
  people: number;
  vehicles: number;
  averageRepresentedCount: number;
  seed: string;
  identitySeed: string;
  center: readonly [number, number];
  includeFocus: boolean;
  spread?: readonly [number, number];
}

function safeEntityCount(value: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, Math.floor(Number.isFinite(value) ? value : 0)));
}

function buildVisualEntities({
  level,
  people,
  vehicles,
  averageRepresentedCount,
  seed,
  identitySeed,
  center,
  includeFocus,
  spread = SPREAD_BY_LEVEL[level],
}: BuildEntitiesOptions): VisualEntity[] {
  const rng = createDeterministicRng(seed);
  const entities: VisualEntity[] = [];

  const stableId = (kind: 'person' | 'vehicle', index: number) =>
    `visual-${kind}-${index.toString().padStart(5, '0')}-${hashSeed(`${identitySeed}:${kind}:${index}`).toString(16).padStart(8, '0')}`;

  for (let index = 0; index < people; index += 1) {
    const angle = rng() * Math.PI * 2;
    const radius = Math.sqrt(rng());
    const representedJitter = 0.55 + rng() * 0.9;
    entities.push({
      id: stableId('person', index),
      kind: 'person',
      representation: 'aggregate_proxy',
      longitude: center[0] + Math.cos(angle) * radius * spread[0],
      latitude: center[1] + Math.sin(angle) * radius * spread[1],
      heading: rng() * 360,
      representedCount: Math.max(1, Math.round(averageRepresentedCount * representedJitter)),
      activity: ACTIVITIES[Math.floor(rng() * ACTIVITIES.length)] ?? 'walk',
      color: rng() > 0.18 ? '#35d7df' : '#76f0c7',
      seed: hashSeed(`${identitySeed}:person:${index}:presentation`),
    });
  }

  for (let index = 0; index < vehicles; index += 1) {
    const corridor = index % 4;
    const progress = rng() * 2 - 1;
    const sideOffset = deterministicBetween(rng, -0.0015, 0.0015);
    const horizontal = corridor % 2 === 0;
    entities.push({
      id: stableId('vehicle', index),
      kind: 'vehicle',
      representation: 'ambient_only',
      longitude: center[0] + (horizontal ? progress * spread[0] : sideOffset),
      latitude: center[1] + (horizontal ? sideOffset : progress * spread[1]),
      heading: horizontal ? (progress > 0 ? 90 : 270) : progress > 0 ? 0 : 180,
      representedCount: 0,
      activity: 'transit',
      color: '#ffb64d',
      seed: hashSeed(`${identitySeed}:vehicle:${index}:presentation`),
    });
  }

  if (includeFocus) {
    entities.unshift({
      id: `visual-focus-${hashSeed(`${identitySeed}:focus`).toString(16).padStart(8, '0')}`,
      kind: 'focus',
      representation: 'focus_person_1to1',
      longitude: center[0] + 0.00055,
      latitude: center[1] - 0.0002,
      heading: 28,
      representedCount: 1,
      activity: 'walk',
      color: '#ffffff',
      seed: hashSeed(`${identitySeed}:focus:presentation`),
    });
  }

  return entities;
}

/**
 * Builds a stable visualization set around the supplied active geography center. The generated entities are
 * presentation geometry only and cannot be aggregated back into model totals.
 */
export function generateVisualEntities({
  zoom,
  seed = 'omnitwin-visual-v1',
  cap = 3_600,
  center,
}: GenerateEntitiesOptions): VisualEntity[] {
  if (!center) return [];
  const isAgentLevel = semanticLevelForZoom(zoom) === 'agent';
  const profile = getLodProfile(zoom, isAgentLevel ? Math.max(1, cap - 1) : cap);
  return buildVisualEntities({
    level: profile.level,
    people: profile.people,
    vehicles: profile.vehicles,
    averageRepresentedCount: profile.averageRepresentedCount,
    seed: `${seed}:${profile.level}:${cap}`,
    identitySeed: seed,
    center,
    includeFocus: isAgentLevel,
  });
}

/**
 * Explicit non-scientific load fixture for the 1080p renderer gate. Counts are
 * exact and intentionally independent from the API bundle population.
 */
export function generatePerformanceEntities({
  zoom = 14.6,
  seed = 'omnitwin-performance-fixture-v2',
  pedestrianCount = 10_000,
  vehicleCount = 2_000,
  center = [0, 0],
}: GeneratePerformanceEntitiesOptions = {}): VisualEntity[] {
  const level = semanticLevelForZoom(zoom);
  const people = safeEntityCount(pedestrianCount, 10_000);
  const vehicles = safeEntityCount(vehicleCount, 2_000);
  const longitudeSpan = 360 / 2 ** Math.max(0, zoom - 0.6);
  return buildVisualEntities({
    level,
    people,
    vehicles,
    averageRepresentedCount: 1,
    seed: `${seed}:${level}:${people}:${vehicles}`,
    identitySeed: seed,
    center,
    includeFocus: false,
    spread: [longitudeSpan * 0.46, longitudeSpan * 0.3],
  });
}

export function representedPopulation(entities: readonly VisualEntity[]): number {
  return entities.reduce(
    (total, entity) =>
      entity.representation === 'ambient_only'
        ? total
        : total + entity.representedCount,
    0,
  );
}

/** Advances presentation geometry without mutating source entities or model state. */
export function synthesizePresentationFrame(
  entities: readonly VisualEntity[],
  presentationMinutes: number,
  reducedMotion = false,
): VisualEntity[] {
  if (reducedMotion) return entities.map((entity) => ({ ...entity }));
  return entities.map((entity) => {
    const phase = ((presentationMinutes + (entity.seed % 1440)) % 1440) / 1440;
    const radians = (entity.heading * Math.PI) / 180;
    const distance =
      entity.kind === 'vehicle'
        ? (phase - 0.5) * 0.0016
        : entity.activity === 'walk'
          ? Math.sin(phase * Math.PI * 2) * 0.00008
          : 0;
    return {
      ...entity,
      longitude: entity.longitude + Math.sin(radians) * distance,
      latitude: entity.latitude + Math.cos(radians) * distance,
    };
  });
}
