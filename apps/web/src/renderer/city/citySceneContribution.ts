import { createEnvironmentSceneController } from '../environment/environmentScene';
import type {
  EnvironmentSceneController,
  EnvironmentSceneState,
} from '../environment/environmentScene';
import {
  readLivingCityDeviceCapabilities,
  resolveLivingCityQualityCaps,
  type LivingCityDeviceCapabilities,
  type LivingCityQualityCaps,
} from '../environment/qualityCaps';
import {
  advanceEnvironmentCycle2025,
  environmentPhaseFromAbsoluteSeconds2025,
  mapToEnvironmentCycle2025,
  type EnvironmentCycle2025,
} from '../environment/cycle2025';
import {
  createVisualWeatherSample,
  createVisualWeatherOverrideSample,
  validateWeatherSample2025,
  type EnvironmentWeatherUnavailableReason,
  type WeatherSample2025,
} from '../environment/weather';
import {
  compileEnvironmentCyclePlayback,
  resolveEnvironmentCycleWeather2025,
  type CompiledEnvironmentCyclePlayback,
  type EnvironmentCyclePlaybackBinding,
  type EnvironmentCyclePlaybackSource,
  type ResolvedEnvironmentCycleWeather,
} from '../environment/weatherCycle';
import { createCityGeometryController, type CityGeometryController } from './cityGeometry';
import { createRussianDistrictPlan } from './districtPlan';
import type {
  CityDistrictPlan,
  CityPlanCell,
  CitySceneContribution,
  CitySceneSnapshot,
  CityWorldAnchor,
  LivingCityThreeContext,
} from './types';

export interface CreateCitySceneContributionOptions {
  readonly defaultPlan?: CityDistrictPlan;
  readonly defaultSeed?: string;
  /** Enables the explicit offline/test fixture; never inferred from network failure. */
  readonly allowSyntheticFixture?: boolean;
  readonly deviceCapabilities?: LivingCityDeviceCapabilities;
}

interface ActiveCityPlanCell {
  readonly cellKey: string;
  readonly root: import('three').Group;
  readonly city: CityGeometryController;
  readonly semanticPlanKey: string;
  plan: CityDistrictPlan;
  anchor: CityWorldAnchor;
  primary: boolean;
}

type ActiveWeatherBindingReason = EnvironmentWeatherUnavailableReason | 'visual_override';

const CELL_KEY = /^\d+\/\d+\/\d+$/u;
const ENVIRONMENT_VISUAL_SEED = 'omnitwin-living-city-environment-v1';
export const CITY_APPEARANCE_SYNTHESIS_VERSION = '1.0.0' as const;

function compareCellKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  const fields = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCellKeys)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${fields.join(',')}}`;
}

const PLAN_SEMANTIC_KEYS = new WeakMap<CityDistrictPlan, string>();

/** Stable content hash; object identity and property insertion order are irrelevant. */
export function cityPlanSemanticKey(plan: CityDistrictPlan): string {
  const cached = PLAN_SEMANTIC_KEYS.get(plan);
  if (cached) return cached;
  const canonical = canonicalJson(plan);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  const key = `${plan.id}:${hash.toString(16).padStart(16, '0')}`;
  PLAN_SEMANTIC_KEYS.set(plan, key);
  return key;
}

function weatherCycleCacheKey(source: EnvironmentCyclePlaybackSource): string {
  return [
    source.manifestSha256,
    source.payloadSha256,
    source.cycle.content.sha256,
    source.sourceSnapshot.inputSha256,
    source.sceneId,
    source.sceneTimeZone,
    source.cycle.cycleId,
  ].join(':');
}

function validateAnchor(anchor: CityWorldAnchor, label: string): void {
  if (
    !Number.isFinite(anchor.mercatorX)
    || !Number.isFinite(anchor.mercatorY)
    || !Number.isFinite(anchor.mercatorZ)
    || !Number.isFinite(anchor.meterInMercatorUnits)
    || anchor.meterInMercatorUnits <= 0
  ) {
    throw new RangeError(`${label} must contain finite positive Mercator units`);
  }
}

function hasValidPolyline(points: readonly { east: number; north: number }[] | undefined): boolean {
  if (!points || points.length < 2) return false;
  if (points.some((point) => !Number.isFinite(point.east) || !Number.isFinite(point.north))) {
    return false;
  }
  return points.some((point, index) => {
    const previous = points[index - 1];
    return previous !== undefined
      && Math.hypot(point.east - previous.east, point.north - previous.north) > 0.01;
  });
}

function hasValidSourceFootprint(
  footprint: readonly { east: number; north: number }[] | undefined,
): boolean {
  if (!footprint || footprint.length < 3) return false;
  if (footprint.some((point) => !Number.isFinite(point.east) || !Number.isFinite(point.north))) {
    return false;
  }
  let twiceArea = 0;
  for (let index = 0; index < footprint.length; index += 1) {
    const current = footprint[index]!;
    const next = footprint[(index + 1) % footprint.length]!;
    twiceArea += current.east * next.north - next.east * current.north;
  }
  return Math.abs(twiceArea) > 0.02;
}

function hasCompleteSourceGeometry(plan: CityDistrictPlan): boolean {
  return plan.buildings.every((building) => hasValidSourceFootprint(building.footprint))
    && plan.roads.every((road) => hasValidPolyline(road.points))
    && plan.sidewalks.every((sidewalk) => hasValidPolyline(sidewalk.points))
    && plan.crosswalks.every((crosswalk) => hasValidPolyline(crosswalk.points));
}

function isFullySourcePlan(plan: CityDistrictPlan): boolean {
  return plan.visualProvenance === 'source_geometry'
    && plan.fieldProvenance.geometry === 'source_geometry'
    && plan.fieldProvenance.buildingAppearance === 'source_attributes'
    && plan.fieldProvenance.streetFurniture === 'source_attributes'
    && plan.fieldProvenance.movement === 'source_network'
    && hasCompleteSourceGeometry(plan);
}

function validatePlanProvenance(plan: CityDistrictPlan): void {
  const fields = plan.fieldProvenance;
  const mixed = fields.geometry === 'source_geometry'
    && hasCompleteSourceGeometry(plan)
    && (
      fields.buildingAppearance === 'visual_synthesis'
      || fields.streetFurniture === 'visual_synthesis'
      || fields.movement === 'visual_synthesis'
    );
  const synthetic = fields.geometry === 'synthetic_visual'
    && fields.buildingAppearance === 'visual_synthesis'
    && fields.streetFurniture === 'visual_synthesis'
    && fields.movement === 'visual_synthesis';
  if (
    plan.scientificClaim !== false
    ||
    (plan.visualProvenance === 'source_geometry' && !isFullySourcePlan(plan))
    || (plan.visualProvenance === 'mixed_source_geometry_synthetic_appearance' && !mixed)
    || (plan.visualProvenance === 'synthetic_visual' && !synthetic)
  ) {
    throw new Error(`City plan ${plan.id} has inconsistent visual field provenance`);
  }
}

function validateSnapshot(snapshot: CitySceneSnapshot): void {
  validateAnchor(snapshot.anchor, 'City scene anchor');
  if (snapshot.plan) validatePlanProvenance(snapshot.plan);
  if (snapshot.planCells !== undefined) {
    let previous = '';
    let primaryCount = 0;
    for (const cell of snapshot.planCells) {
      if (!CELL_KEY.test(cell.cellKey)) {
        throw new RangeError('City plan cell key must use the z/x/y form');
      }
      if (previous && compareCellKeys(previous, cell.cellKey) >= 0) {
        throw new RangeError('City plan cells must be uniquely sorted by cellKey');
      }
      previous = cell.cellKey;
      if (cell.primary) primaryCount += 1;
      validateAnchor(cell.anchor, `City plan cell ${cell.cellKey} anchor`);
      validatePlanProvenance(cell.plan);
    }
    if (snapshot.planCells.length > 0 && primaryCount !== 1) {
      throw new RangeError('City plan cells require exactly one primary cell');
    }
  }
  if (!snapshot.timeZone.trim()) throw new RangeError('City scene requires an IANA timeZone');
  if (
    snapshot.absolutePresentationSeconds !== undefined
    && !Number.isFinite(snapshot.absolutePresentationSeconds)
  ) {
    throw new RangeError('City scene absolute presentation clock must be finite');
  }
  if (!Number.isFinite(snapshot.latitude) || snapshot.latitude < -90 || snapshot.latitude > 90) {
    throw new RangeError('City scene latitude must be between -90 and 90');
  }
  if (!Number.isFinite(snapshot.longitude) || snapshot.longitude < -180 || snapshot.longitude > 180) {
    throw new RangeError('City scene longitude must be between -180 and 180');
  }
  if (
    snapshot.weatherSample
    && snapshot.weatherSample.sourceProvenance !== 'visual_synthesis'
    && !snapshot.weatherSample.source
  ) {
    throw new Error('Non-synthetic environment weather requires pinned source metadata');
  }
  if (snapshot.weatherSample) validateWeatherSample2025(snapshot.weatherSample);
  if (snapshot.weatherSample && snapshot.weatherBindingUnavailableReason) {
    throw new Error('Weather sample and unavailable binding reason are mutually exclusive');
  }
}

function setCellTransform(root: import('three').Group, anchor: CityWorldAnchor): void {
  root.position.set(anchor.mercatorX, anchor.mercatorY, anchor.mercatorZ);
  root.scale.setScalar(anchor.meterInMercatorUnits);
}

/**
 * Standalone contribution for the sole shared Three context. It owns only its
 * roots and resources; the MapLibre map, canvas and renderer remain runtime-owned.
 */
export function createCitySceneContribution(
  options: CreateCitySceneContributionOptions = {},
): CitySceneContribution {
  const defaultSeed = options.defaultSeed ?? 'omnitwin-synthetic-city-fixture';
  const fixturePlan = options.allowSyntheticFixture
    ? options.defaultPlan ?? createRussianDistrictPlan({
      id: 'omnitwin-synthetic-city-fixture',
      seed: defaultSeed,
      layoutMode: 'synthetic_visual',
    })
    : options.defaultPlan;
  if (
    fixturePlan?.visualProvenance === 'synthetic_visual'
    && !options.allowSyntheticFixture
  ) {
    throw new Error('Synthetic city plan requires allowSyntheticFixture=true');
  }

  let context: LivingCityThreeContext | null = null;
  let snapshot: CitySceneSnapshot | null = null;
  let root: import('three').Group | null = null;
  let environmentRoot: import('three').Group | null = null;
  let environment: EnvironmentSceneController | null = null;
  let qualityCaps: LivingCityQualityCaps | null = null;
  let disposed = false;
  let abortSignal: AbortSignal | null = null;
  let lastWeatherParticles = 0;
  let activeWeatherSample: WeatherSample2025 | null = null;
  let renderedWeatherSample: WeatherSample2025 | null = null;
  let activeWeatherBindingReason: ActiveWeatherBindingReason | undefined;
  let compiledWeatherCycle: CompiledEnvironmentCyclePlayback | null = null;
  let cachedWeatherCycleKey = '';
  let cachedWeatherCycleBinding: EnvironmentCyclePlaybackBinding | null = null;
  let weatherCycleCompiles = 0;
  let activeWeatherResolution: ResolvedEnvironmentCycleWeather | null = null;
  let activeEnvironmentCycle: EnvironmentCycle2025 | null = null;
  let anchorAbsolutePresentationSeconds: number | null = null;
  let detectedDeviceCapabilities: LivingCityDeviceCapabilities | null = null;
  let desiredPlanCells: readonly CityPlanCell[] = [];
  const activeCells = new Map<string, ActiveCityPlanCell>();
  let planCellAdds = 0;
  let planCellRemoves = 0;
  let planCellRebuilds = 0;

  const removeAbortListener = () => {
    abortSignal?.removeEventListener('abort', detach);
    abortSignal = null;
  };

  const disposeEnvironment = () => {
    if (root && environmentRoot) root.remove(environmentRoot);
    if (environmentRoot && environment) environmentRoot.remove(environment.group);
    environment?.dispose();
    environment = null;
    environmentRoot = null;
    renderedWeatherSample = null;
    activeEnvironmentCycle = null;
    anchorAbsolutePresentationSeconds = null;
    lastWeatherParticles = 0;
  };

  const disposeCell = (cell: ActiveCityPlanCell) => {
    if (root) root.remove(cell.root);
    cell.root.remove(cell.city.group);
    cell.city.dispose();
  };

  const clearSceneControllers = () => {
    for (const cell of activeCells.values()) disposeCell(cell);
    activeCells.clear();
    disposeEnvironment();
    qualityCaps = null;
    desiredPlanCells = [];
    activeEnvironmentCycle = null;
    anchorAbsolutePresentationSeconds = null;
    activeWeatherSample = null;
    renderedWeatherSample = null;
    activeWeatherBindingReason = undefined;
    compiledWeatherCycle = null;
    activeWeatherResolution = null;
    lastWeatherParticles = 0;
  };

  const detach = () => {
    clearSceneControllers();
    if (context && root) context.scene.remove(root);
    root = null;
    context = null;
    removeAbortListener();
  };

  const deviceCapabilities = () => {
    if (options.deviceCapabilities) return options.deviceCapabilities;
    detectedDeviceCapabilities ??= readLivingCityDeviceCapabilities();
    return detectedDeviceCapabilities;
  };

  const snapshotPlanCells = (nextSnapshot: CitySceneSnapshot): readonly CityPlanCell[] => {
    if (nextSnapshot.planCells !== undefined) return nextSnapshot.planCells;
    const plan = nextSnapshot.plan ?? fixturePlan;
    if (!plan) return [];
    return [{
      cellKey: 'legacy/0/0',
      primary: true,
      anchor: nextSnapshot.anchor,
      plan,
    }];
  };

  const assertSyntheticPermission = (cells: readonly CityPlanCell[]) => {
    for (const cell of cells) validatePlanProvenance(cell.plan);
    if (
      !options.allowSyntheticFixture
      && cells.some((cell) => cell.plan.fieldProvenance.geometry === 'synthetic_visual')
    ) {
      throw new Error('Synthetic city plan requires allowSyntheticFixture=true');
    }
  };

  const createCell = (
    planCell: CityPlanCell,
    semanticPlanKey: string,
    caps: LivingCityQualityCaps,
  ): ActiveCityPlanCell => {
    if (!context || !root) throw new Error('City contribution is not attached');
    const cellRoot = new context.THREE.Group();
    cellRoot.name = `omnitwin-city-cell:${planCell.cellKey}`;
    setCellTransform(cellRoot, planCell.anchor);
    const city = createCityGeometryController({
      THREE: context.THREE,
      plan: planCell.plan,
      qualityCaps: caps,
    });
    cellRoot.add(city.group);
    root.add(cellRoot);
    return {
      cellKey: planCell.cellKey,
      root: cellRoot,
      city,
      semanticPlanKey,
      plan: planCell.plan,
      anchor: planCell.anchor,
      primary: planCell.primary,
    };
  };

  const syncPlanCells = (nextSnapshot: CitySceneSnapshot) => {
    if (!context || !root) return;
    const nextCells = snapshotPlanCells(nextSnapshot);
    assertSyntheticPermission(nextCells);
    desiredPlanCells = nextCells;
    const nextCaps = resolveLivingCityQualityCaps(
      nextSnapshot.quality,
      deviceCapabilities(),
      false,
    );
    const qualityChanged = Boolean(
      qualityCaps
      && qualityCaps.effectiveQuality !== nextCaps.effectiveQuality,
    );
    if (qualityChanged) disposeEnvironment();

    const nextKeys = new Set(nextCells.map((cell) => cell.cellKey));
    for (const [cellKey, active] of activeCells) {
      if (nextKeys.has(cellKey)) continue;
      disposeCell(active);
      activeCells.delete(cellKey);
      planCellRemoves += 1;
    }

    for (const nextCell of nextCells) {
      const semanticPlanKey = cityPlanSemanticKey(nextCell.plan);
      const existing = activeCells.get(nextCell.cellKey);
      const needsRebuild = Boolean(
        existing
        && (qualityChanged || existing.semanticPlanKey !== semanticPlanKey),
      );

      if (existing && needsRebuild) {
        disposeCell(existing);
        activeCells.delete(nextCell.cellKey);
        planCellRebuilds += 1;
      }

      const reusable = activeCells.get(nextCell.cellKey);
      if (reusable) {
        reusable.plan = nextCell.plan;
        reusable.anchor = nextCell.anchor;
        reusable.primary = nextCell.primary;
        setCellTransform(reusable.root, nextCell.anchor);
        continue;
      }

      activeCells.set(
        nextCell.cellKey,
        createCell(nextCell, semanticPlanKey, nextCaps),
      );
      if (!existing) planCellAdds += 1;
    }
    qualityCaps = nextCaps;

    if (activeCells.size === 0) {
      disposeEnvironment();
      return;
    }
    const primary = nextCells.find((cell) => cell.primary && activeCells.has(cell.cellKey))
      ?? nextCells.find((cell) => activeCells.has(cell.cellKey));
    if (!primary) {
      disposeEnvironment();
      return;
    }
    if (!environment) {
      environmentRoot = new context.THREE.Group();
      environmentRoot.name = 'omnitwin-city-environment-root';
      environment = createEnvironmentSceneController({
        THREE: context.THREE,
        scene: context.scene,
        qualityCaps: nextCaps,
        seed: ENVIRONMENT_VISUAL_SEED,
      });
      environmentRoot.add(environment.group);
      root.add(environmentRoot);
    }
    if (environmentRoot) setCellTransform(environmentRoot, primary.anchor);

    // Keep deterministic draw traversal even after an out-of-order cell replacement.
    for (const nextCell of nextCells) {
      const active = activeCells.get(nextCell.cellKey);
      if (active) root.add(active.root);
    }
  };

  const bindSnapshotWeather = (nextSnapshot: CitySceneSnapshot) => {
    activeWeatherSample = nextSnapshot.weatherSample ?? null;
    activeWeatherBindingReason = nextSnapshot.weatherBindingUnavailableReason;
    compiledWeatherCycle = null;
    activeWeatherResolution = null;
    if (
      nextSnapshot.weatherVisualOverride !== null
      && nextSnapshot.weatherVisualOverride !== undefined
    ) {
      activeWeatherSample = createVisualWeatherOverrideSample(
        mapToEnvironmentCycle2025(nextSnapshot.presentationTime, nextSnapshot.timeZone),
        nextSnapshot.weatherVisualOverride,
        nextSnapshot.weatherIntensity ?? 0.7,
      );
      activeWeatherBindingReason = 'visual_override';
      return;
    }
    if (!nextSnapshot.weatherCyclePlayback) return;
    const cacheKey = weatherCycleCacheKey(nextSnapshot.weatherCyclePlayback);
    if (cacheKey !== cachedWeatherCycleKey || !cachedWeatherCycleBinding) {
      cachedWeatherCycleKey = cacheKey;
      cachedWeatherCycleBinding = compileEnvironmentCyclePlayback(
        nextSnapshot.weatherCyclePlayback,
      );
      weatherCycleCompiles += 1;
    }
    const compiled = cachedWeatherCycleBinding;
    if (compiled.status === 'unavailable') {
      activeWeatherSample = null;
      activeWeatherBindingReason = compiled.reason;
      return;
    }
    compiledWeatherCycle = compiled.binding;
    const presentationSeconds = nextSnapshot.absolutePresentationSeconds
      ?? new Date(nextSnapshot.presentationTime).valueOf() / 1_000;
    try {
      activeWeatherResolution = resolveEnvironmentCycleWeather2025(
        compiled.binding,
        presentationSeconds,
      );
      activeWeatherSample = activeWeatherResolution.sample;
      activeWeatherBindingReason = undefined;
    } catch {
      compiledWeatherCycle = null;
      activeWeatherSample = null;
      activeWeatherBindingReason = 'CYCLE_STEPS_INVALID';
    }
  };

  const updateCitiesEnvironment = (state: EnvironmentSceneState) => {
    for (const cell of activeCells.values()) cell.city.updateEnvironment(state);
  };

  const synchronize = () => {
    if (!context || !root || !snapshot) return;
    validateSnapshot(snapshot);
    syncPlanCells(snapshot);
    if (!environment || !qualityCaps || activeCells.size === 0) {
      lastWeatherParticles = 0;
      context.requestRepaint();
      return;
    }

    const primary = desiredPlanCells.find(
      (cell) => cell.primary && activeCells.has(cell.cellKey),
    ) ?? desiredPlanCells.find((cell) => activeCells.has(cell.cellKey));
    if (!primary) return;
    const layerVisibility = snapshot.layerVisibility ?? {
      buildings: true,
      infrastructure: true,
      weather: true,
    };
    for (const cell of activeCells.values()) {
      cell.city.setLayerVisibility(layerVisibility);
    }
    environment.setWeatherVisible(layerVisibility.weather);
    const cycle = mapToEnvironmentCycle2025(snapshot.presentationTime, snapshot.timeZone);
    const weather = activeWeatherSample ?? createVisualWeatherSample(
      cycle,
      snapshot.weatherMode,
      snapshot.weatherIntensity ?? 0.7,
      ENVIRONMENT_VISUAL_SEED,
    );
    renderedWeatherSample = weather;
    if (!activeWeatherBindingReason) activeWeatherSample = weather;
    const environmentState = environment.update({
      presentationTime: snapshot.presentationTime,
      timeZone: snapshot.timeZone,
      latitude: snapshot.latitude,
      longitude: snapshot.longitude,
      weather,
      reducedMotion: snapshot.reducedMotion,
      meterInWorldUnits: primary.anchor.meterInMercatorUnits,
    });
    activeEnvironmentCycle = cycle;
    anchorAbsolutePresentationSeconds = snapshot.absolutePresentationSeconds ?? null;
    for (const cell of activeCells.values()) {
      cell.city.setReducedMotion(snapshot.reducedMotion);
      cell.city.setPresentationTime(cycle.localPhaseMs);
    }
    updateCitiesEnvironment(environmentState);
    lastWeatherParticles = layerVisibility.weather
      ? environmentState.weather.particleCount
      : 0;
    context.requestRepaint();
  };

  const sceneDetail = () => {
    const allAttached = desiredPlanCells.length > 0
      && activeCells.size === desiredPlanCells.length
      && desiredPlanCells.every((cell) => {
        const active = activeCells.get(cell.cellKey);
        return active?.semanticPlanKey === cityPlanSemanticKey(cell.plan);
      });
    const allSourceGeometry = desiredPlanCells.length > 0
      && desiredPlanCells.every(
        (cell) => cell.plan.fieldProvenance.geometry === 'source_geometry'
          && hasCompleteSourceGeometry(cell.plan),
      );
    const allSourceBuildingGeometry = desiredPlanCells.length > 0
      && desiredPlanCells.every(
        (cell) => cell.plan.fieldProvenance.geometry === 'source_geometry'
          && cell.plan.buildings.every(
            (building) => hasValidSourceFootprint(building.footprint),
          ),
      );
    const hasSourceBuildingOrRoad = desiredPlanCells.some(
      (cell) => cell.plan.buildings.length > 0 || cell.plan.roads.length > 0,
    );
    const hasSourceBuilding = desiredPlanCells.some(
      (cell) => cell.plan.buildings.length > 0,
    );
    const detailedBuildingGeometryReady = allAttached
      && allSourceBuildingGeometry
      && hasSourceBuilding;
    const sceneGeometryStatus = allAttached && allSourceGeometry && hasSourceBuildingOrRoad
      ? 'SCENE_GEOMETRY_READY' as const
      : activeCells.size > 0
        ? 'SCENE_GEOMETRY_PARTIAL' as const
        : 'SCENE_GEOMETRY_UNAVAILABLE' as const;
    const allSourceAppearance = allAttached && desiredPlanCells.every(
      (cell) => cell.plan.fieldProvenance.buildingAppearance === 'source_attributes'
        && cell.plan.fieldProvenance.streetFurniture === 'source_attributes',
    );
    const hasSyntheticAppearance = allAttached && desiredPlanCells.some(
      (cell) => cell.plan.fieldProvenance.buildingAppearance === 'visual_synthesis'
        || cell.plan.fieldProvenance.streetFurniture === 'visual_synthesis',
    );
    const sceneAppearanceStatus = allSourceAppearance
      ? 'APPEARANCE_SOURCE' as const
      : hasSyntheticAppearance
        ? 'APPEARANCE_SYNTHETIC' as const
        : 'APPEARANCE_UNAVAILABLE' as const;
    const allSourceMovement = allAttached && desiredPlanCells.every(
      (cell) => cell.plan.fieldProvenance.movement === 'source_network',
    );
    const sceneMovementProvenance = allSourceMovement
      ? 'source_network' as const
      : allAttached && desiredPlanCells.some(
        (cell) => cell.plan.fieldProvenance.movement === 'visual_synthesis',
      )
        ? 'visual_synthesis' as const
        : 'unavailable' as const;
    const ready = sceneGeometryStatus === 'SCENE_GEOMETRY_READY'
      && sceneMovementProvenance === 'source_network'
      && Boolean(environment);
    const status = ready && sceneAppearanceStatus === 'APPEARANCE_SOURCE'
      ? 'SCENE_DETAIL_READY' as const
      : activeCells.size > 0
        ? 'SCENE_DETAIL_PARTIAL' as const
        : 'SCENE_DETAIL_UNAVAILABLE' as const;
    const activePlans = [...activeCells.values()].map((cell) => cell.plan);
    const visualProvenance = activeCells.size === 0
      ? null
      : activePlans.every(isFullySourcePlan)
        ? 'source_geometry' as const
        : activePlans.every((plan) => plan.fieldProvenance.geometry === 'source_geometry')
          ? 'mixed_source_geometry_synthetic_appearance' as const
          : 'synthetic_visual' as const;
    return {
      ready,
      status,
      visualProvenance,
      detailedBuildingGeometryReady,
      sceneGeometryStatus,
      sceneAppearanceStatus,
      sceneMovementProvenance,
      sceneAppearanceScientificClaim:
        sceneAppearanceStatus === 'APPEARANCE_SYNTHETIC' ? false as const : null,
      sceneAppearanceSynthesisVersion:
        sceneAppearanceStatus === 'APPEARANCE_SYNTHETIC'
          ? CITY_APPEARANCE_SYNTHESIS_VERSION
          : null,
    };
  };

  return {
    id: 'living-city',
    attach(nextContext, signal) {
      if (disposed) throw new Error('City scene contribution is disposed');
      if (context || root) detach();
      context = nextContext;
      root = new nextContext.THREE.Group();
      root.name = 'omnitwin-living-city-root';
      nextContext.scene.add(root);
      abortSignal = signal;
      signal.addEventListener('abort', detach, { once: true });
      if (signal.aborted) {
        detach();
        return;
      }
      if (snapshot) bindSnapshotWeather(snapshot);
      synchronize();
    },
    update(nextSnapshot) {
      if (disposed) return;
      validateSnapshot(nextSnapshot);
      snapshot = nextSnapshot;
      bindSnapshotWeather(nextSnapshot);
      synchronize();
    },
    frame(frame) {
      if (
        disposed
        || !context
        || !snapshot
        || !activeEnvironmentCycle
        || !environment
      ) return;
      if (frame.sceneTimeZone && frame.sceneTimeZone !== snapshot.timeZone) return;
      const reduceMotion = frame.reducedMotion || snapshot.reducedMotion;
      for (const cell of activeCells.values()) cell.city.setReducedMotion(reduceMotion);
      if (anchorAbsolutePresentationSeconds === null) {
        const frameAdvanceSeconds = frame.paused
          ? 0
          : frame.deltaMs / 1_000
            * frame.baseRateSecondsPerWallSecond
            * frame.speedMultiplier;
        anchorAbsolutePresentationSeconds = frame.absolutePresentationSeconds
          - frameAdvanceSeconds;
      }
      const presentationTimeMs = environmentPhaseFromAbsoluteSeconds2025(
        activeEnvironmentCycle.localPhaseMs,
        anchorAbsolutePresentationSeconds,
        frame.absolutePresentationSeconds,
      );
      let frameWeather: WeatherSample2025 | undefined;
      if (
        snapshot.weatherVisualOverride !== null
        && snapshot.weatherVisualOverride !== undefined
      ) {
        frameWeather = createVisualWeatherOverrideSample(
          advanceEnvironmentCycle2025(activeEnvironmentCycle, presentationTimeMs),
          snapshot.weatherVisualOverride,
          snapshot.weatherIntensity ?? 0.7,
        );
        activeWeatherSample = frameWeather;
        renderedWeatherSample = frameWeather;
        activeWeatherBindingReason = 'visual_override';
        activeWeatherResolution = null;
      } else if (compiledWeatherCycle) {
        activeWeatherResolution = resolveEnvironmentCycleWeather2025(
          compiledWeatherCycle,
          frame.absolutePresentationSeconds,
        );
        activeWeatherSample = activeWeatherResolution.sample;
        renderedWeatherSample = activeWeatherResolution.sample;
        activeWeatherBindingReason = undefined;
        frameWeather = activeWeatherResolution.sample;
      }
      const environmentState = environment.setPresentationTime(
        presentationTimeMs,
        frameWeather,
      );
      if (environmentState) {
        updateCitiesEnvironment(environmentState);
        lastWeatherParticles = snapshot.layerVisibility?.weather === false
          ? 0
          : environmentState.weather.particleCount;
      }
      if (!reduceMotion) {
        for (const cell of activeCells.values()) {
          cell.city.setPresentationTime(presentationTimeMs);
        }
      }
      for (const cell of activeCells.values()) cell.city.frame(frame.deltaMs);
      environment.frame(frame.deltaMs);
      if (!reduceMotion) context.requestRepaint();
    },
    telemetry() {
      const weatherBindingStatus = activeWeatherBindingReason === 'visual_override'
        ? 'WEATHER_SYNTHETIC'
        : activeWeatherBindingReason || !activeWeatherSample
        ? 'WEATHER_UNAVAILABLE'
        : activeWeatherSample.sourceProvenance === 'visual_synthesis'
          ? 'WEATHER_SYNTHETIC'
          : 'WEATHER_READY';
      const detail = sceneDetail();
      const telemetryWeatherSample = renderedWeatherSample ?? activeWeatherSample;
      const stats = [...activeCells.values()].reduce(
        (total, cell) => ({
          buildings: total.buildings + cell.city.stats.buildings,
          trees: total.trees + cell.city.stats.trees,
          props: total.props + cell.city.stats.props,
          vehicles: total.vehicles + cell.city.stats.vehicles,
          drawGroups: total.drawGroups + cell.city.stats.drawGroups,
        }),
        { buildings: 0, trees: 0, props: 0, vehicles: 0, drawGroups: 0 },
      );
      const activePlans = [...activeCells.values()].map((cell) => cell.plan);
      const buildingArchetypes = [...new Set(
        activePlans.flatMap((plan) => plan.buildings.map((building) => building.archetype)),
      )].sort();
      const streetFurnitureKinds = [...new Set(
        activePlans.flatMap((plan) => plan.props
          .map((prop) => prop.kind)
          .filter((kind) => kind !== 'tree')),
      )].sort();
      const urbanComposition = {
        buildings: activePlans.reduce((total, plan) => total + plan.buildings.length, 0),
        buildingArchetypes,
        roads: activePlans.reduce((total, plan) => total + plan.roads.length, 0),
        sidewalks: activePlans.reduce((total, plan) => total + plan.sidewalks.length, 0),
        crosswalks: activePlans.reduce((total, plan) => total + plan.crosswalks.length, 0),
        trees: activePlans.reduce(
          (total, plan) => total + plan.props.filter((prop) => prop.kind === 'tree').length,
          0,
        ),
        streetFurnitureKinds,
        renderedBuildings: stats.buildings,
        renderedDrawGroups: stats.drawGroups,
      };
      return {
        id: 'living-city',
        ready: Boolean(context && root && detail.ready),
        attached: Boolean(context && root),
        detailedBuildingGeometryReady: detail.detailedBuildingGeometryReady,
        ...stats,
        weatherParticles: lastWeatherParticles,
        planCells: [...activeCells.keys()].sort(compareCellKeys),
        planCellAdds,
        planCellRemoves,
        planCellRebuilds,
        urbanComposition,
        quality: qualityCaps?.effectiveQuality ?? null,
        sceneDetailStatus: detail.status,
        sceneGeometryStatus: detail.sceneGeometryStatus,
        sceneAppearanceStatus: detail.sceneAppearanceStatus,
        sceneMovementProvenance: detail.sceneMovementProvenance,
        sceneAppearanceScientificClaim: detail.sceneAppearanceScientificClaim,
        sceneAppearanceSynthesisVersion: detail.sceneAppearanceSynthesisVersion,
        visualProvenance: detail.visualProvenance,
        weatherBindingStatus,
        weatherDisplayLabel: telemetryWeatherSample?.displayLabel ?? null,
        weatherCondition: telemetryWeatherSample?.mode ?? null,
        weatherSourceProvenance: telemetryWeatherSample?.sourceProvenance ?? null,
        weatherWindDirectionProvenance:
          telemetryWeatherSample?.fieldProvenance.windDirectionDegrees ?? null,
        weatherBindingReason: activeWeatherBindingReason ?? null,
        weatherCycleId: activeWeatherResolution?.cycleId ?? null,
        weatherCycleStepIndex: activeWeatherResolution?.stepIndex ?? null,
        weatherCycleStepIndices: activeWeatherResolution?.stepIndices ?? [],
        weatherSourceReferences: activeWeatherResolution?.sourceReferences ?? [],
        weatherLocalDateKey: activeWeatherResolution?.localDateKey ?? null,
        weatherLocalMinuteOfDay: activeWeatherResolution?.localMinuteOfDay ?? null,
        weatherResolvedTemperatureC:
          activeWeatherResolution?.resolvedFields.temperatureC ?? null,
        weatherResolvedPrecipitationMmPerHour:
          activeWeatherResolution?.resolvedFields.precipitationMmPerHour ?? null,
        weatherResolvedCloudCover:
          activeWeatherResolution?.resolvedFields.cloudCover ?? null,
        weatherResolvedWindMps:
          activeWeatherResolution?.resolvedFields.windMps ?? null,
        weatherResolvedWindDirectionDegrees:
          activeWeatherResolution?.resolvedFields.windDirectionDegrees ?? null,
        weatherCycleCompiles,
        weatherPresentationTimeIso: activeWeatherResolution?.presentationTimeIso ?? null,
        weatherSourceTimeIso: activeWeatherResolution?.sourceTimeIso ?? null,
        weatherManifestSha256: activeWeatherResolution?.manifestSha256 ?? null,
        weatherCyclePayloadSha256: activeWeatherResolution?.payloadSha256 ?? null,
        weatherSourceInputSha256: activeWeatherResolution?.sourceInputSha256 ?? null,
        weatherTemporalMappingPolicy:
          activeWeatherResolution?.temporalMappingDetails.policy ?? null,
        weatherTemporalMappingDerivationVersion:
          activeWeatherResolution?.temporalMappingDetails.derivationVersion ?? null,
        weatherTemporalMappingFormula:
          activeWeatherResolution?.temporalMappingDetails.formula ?? null,
      };
    },
    dispose() {
      if (disposed) return;
      detach();
      snapshot = null;
      cachedWeatherCycleKey = '';
      cachedWeatherCycleBinding = null;
      disposed = true;
    },
  };
}
