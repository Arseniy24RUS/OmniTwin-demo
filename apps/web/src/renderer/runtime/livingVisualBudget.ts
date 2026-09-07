import type { VisualEntity, VisualEntityV2 } from '../types';
import type { LivingDeviceCaps } from '../living/types';
import { hashSeed } from '../rng';
import { universalInstanceCaps } from '../universal/lod';
import type { UniversalQualityTier } from '../universal/types';

export interface LivingVisualBudgetCounts {
  readonly total: number;
  readonly people: number;
  readonly vehicles: number;
  /** Scientific population represented by rows; ambient transport contributes zero. */
  readonly representedPopulation: number;
}

export interface LivingVisualBudgetResult {
  readonly entities: readonly VisualEntity[];
  /** Defined only when the caller supplied V2 rows. Order exactly matches `entities`. */
  readonly entitiesV2: readonly VisualEntityV2[] | undefined;
  readonly tier: UniversalQualityTier;
  readonly limits: {
    readonly people: number;
    readonly vehicles: number;
  };
  readonly input: LivingVisualBudgetCounts;
  readonly retained: LivingVisualBudgetCounts;
  readonly omitted: LivingVisualBudgetCounts;
  readonly capExemptRetained: {
    readonly total: number;
    readonly selected: number;
    readonly focus: number;
  };
  /** Prevents the downstream LOD pass from culling rows already admitted here. */
  readonly partitionCaps: Readonly<LivingDeviceCaps>;
}

export interface LivingVisualBudgetInput {
  readonly entities: readonly VisualEntity[];
  readonly entitiesV2?: readonly VisualEntityV2[];
  readonly selectedId: string | null;
  readonly tier: UniversalQualityTier;
  /** Living-cell focus samples are numerous and stay bounded; only the selected row is pinned. */
  readonly focusCapPolicy?: 'exempt' | 'bounded';
  /** Counts pinned rows inside the tier caps instead of expanding the cap. */
  readonly strictTierCaps?: boolean;
}

interface RankedEntity {
  readonly entity: VisualEntity;
  readonly hash: number;
  readonly selected: boolean;
  readonly focus: boolean;
}

const RANK_NAMESPACE = 'omnitwin-living-visual-budget-v1\u0000';

function isVehicle(entity: VisualEntity): boolean {
  return entity.kind === 'vehicle';
}

function stableRank(left: RankedEntity, right: RankedEntity): number {
  if (left.hash !== right.hash) return left.hash - right.hash;
  if (left.entity.id < right.entity.id) return -1;
  if (left.entity.id > right.entity.id) return 1;
  return 0;
}

function counts(entities: readonly VisualEntity[]): LivingVisualBudgetCounts {
  let people = 0;
  let vehicles = 0;
  let representedPopulation = 0;
  for (const entity of entities) {
    if (isVehicle(entity)) vehicles += 1;
    else people += 1;
    representedPopulation += entity.representedCount;
  }
  return Object.freeze({
    total: entities.length,
    people,
    vehicles,
    representedPopulation,
  });
}

function difference(
  input: LivingVisualBudgetCounts,
  retained: LivingVisualBudgetCounts,
): LivingVisualBudgetCounts {
  return Object.freeze({
    total: input.total - retained.total,
    people: input.people - retained.people,
    vehicles: input.vehicles - retained.vehicles,
    representedPopulation: input.representedPopulation - retained.representedPopulation,
  });
}

function alignedV2Rows(
  entities: readonly VisualEntity[],
  source: readonly VisualEntityV2[] | undefined,
): readonly VisualEntityV2[] | undefined {
  if (source === undefined) return undefined;
  if (source.length === 0) return Object.freeze([]);
  const byId = new Map<string, VisualEntityV2>();
  for (const row of source) {
    if (byId.has(row.id)) throw new Error(`Living visual budget duplicate V2 id: ${row.id}`);
    byId.set(row.id, row);
  }
  const aligned: VisualEntityV2[] = [];
  for (const entity of entities) {
    const row = byId.get(entity.id);
    if (!row) throw new Error(`Living visual budget missing V2 row: ${entity.id}`);
    aligned.push(row);
  }
  return Object.freeze(aligned);
}

/**
 * Bounds universal living rows before graph compilation and typed-array allocation.
 * Focus rows and the selected row are explicit cap exceptions. Their scientific
 * representedCount is retained verbatim; omitted population is reported, never
 * redistributed into another visual row.
 */
export function applyLivingVisualBudget({
  entities,
  entitiesV2,
  selectedId,
  tier,
  focusCapPolicy = 'exempt',
  strictTierCaps = false,
}: LivingVisualBudgetInput): LivingVisualBudgetResult {
  const tierCaps = universalInstanceCaps(tier);
  const limits = Object.freeze({
    people: tierCaps.maxAmbientPeople,
    vehicles: tierCaps.maxAmbientVehicles,
  });
  const ids = new Set<string>();
  const ranked: RankedEntity[] = [];
  for (const entity of entities) {
    if (!entity.id || ids.has(entity.id)) {
      throw new Error(`Living visual budget duplicate or empty entity id: ${entity.id}`);
    }
    ids.add(entity.id);
    ranked.push({
      entity,
      hash: hashSeed(`${RANK_NAMESPACE}${entity.id}`),
      selected: selectedId === entity.id,
      focus: focusCapPolicy === 'exempt'
        && entity.representation === 'focus_person_1to1',
    });
  }

  const capExempt: RankedEntity[] = [];
  const people: RankedEntity[] = [];
  const vehicles: RankedEntity[] = [];
  for (const candidate of ranked) {
    if (candidate.selected || candidate.focus) capExempt.push(candidate);
    else if (isVehicle(candidate.entity)) vehicles.push(candidate);
    else people.push(candidate);
  }
  capExempt.sort(stableRank);
  people.sort(stableRank);
  vehicles.sort(stableRank);

  const pinnedPeople = strictTierCaps
    ? capExempt.filter(({ entity }) => !isVehicle(entity)).length
    : 0;
  const pinnedVehicles = strictTierCaps
    ? capExempt.filter(({ entity }) => isVehicle(entity)).length
    : 0;

  const retainedRanked = [
    ...capExempt,
    ...people.slice(0, Math.max(0, limits.people - pinnedPeople)),
    ...vehicles.slice(0, Math.max(0, limits.vehicles - pinnedVehicles)),
  ].sort(stableRank);
  const retainedEntities = Object.freeze(retainedRanked.map(({ entity }) => entity));
  const inputCounts = counts(entities);
  const retainedCounts = counts(retainedEntities);
  const totalRetained = retainedCounts.total;
  const partitionCaps: Readonly<LivingDeviceCaps> = Object.freeze({
    maxPedestrians: retainedCounts.people,
    maxVehicles: retainedCounts.vehicles,
    maxDetailedPedestrians: retainedCounts.people,
    maxDetailedVehicles: retainedCounts.vehicles,
    maxDetailed: totalRetained,
    maxLow: totalRetained,
    maxImpostors: totalRetained,
    maxChunkEntities: Math.max(1, Math.min(512, totalRetained)),
  });

  return Object.freeze({
    entities: retainedEntities,
    entitiesV2: alignedV2Rows(retainedEntities, entitiesV2),
    tier,
    limits,
    input: inputCounts,
    retained: retainedCounts,
    omitted: difference(inputCounts, retainedCounts),
    capExemptRetained: Object.freeze({
      total: capExempt.length,
      selected: capExempt.some(({ selected }) => selected) ? 1 : 0,
      focus: capExempt.filter(({ focus }) => focus).length,
    }),
    partitionCaps,
  });
}
