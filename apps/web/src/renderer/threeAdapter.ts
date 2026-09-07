import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl';
import { createCitySceneContribution } from './city';
import type { CitySceneSnapshot } from './city';
import { bindEnvironmentWeatherSample } from './environment/weather';
import {
  LivingKind,
  LivingPrimaryRenderer,
} from './living/types';
import { rendererQualityProfile } from './qualityProfile';
import type {
  RendererAdapter,
  RendererQuality,
  RendererLivingSnapshot,
  RendererSceneSnapshot,
  VisualEntity,
} from './types';

export interface ThreeLayerAdapter extends RendererAdapter {
  layer: CustomLayerInterface;
}

export interface ThreeEntityLayerOptions {
  cityRendererV2?: boolean;
  initialScene?: RendererSceneSnapshot;
}

export function citySnapshotFromRenderer(
  snapshot: RendererSceneSnapshot,
): CitySceneSnapshot | null {
  const binding = snapshot.scenePack;
  const payload = binding?.cityPayload;
  if (
    !binding ||
    binding.sourceDetailStatus !== 'available' ||
    !payload ||
    !payload.presentationTimeIso
  ) return null;
  const sourceSnapshot = payload.environment
    ? binding.manifest?.sourceSnapshots.find(
      (source) => source.sourceId === payload.environment?.sourceId,
    )
    : undefined;
  const environmentWeather = payload.environment
    ? bindEnvironmentWeatherSample(payload.environment, sourceSnapshot)
    : null;
  const cycleUnavailableReason = payload.environment
    && payload.environment.provenance !== 'visual_synthesis'
    && !payload.weatherCyclePlayback
    ? 'CYCLE_REQUIRED' as const
    : undefined;
  const initialWeatherSample = payload.weatherSample
    ?? (environmentWeather?.status === 'ready' ? environmentWeather.sample : undefined);
  const unavailableReason = cycleUnavailableReason
    ?? (environmentWeather?.status === 'unavailable' ? environmentWeather.reason : undefined);
  const weatherSample = unavailableReason ? undefined : initialWeatherSample;
  return {
    anchor: payload.anchor,
    plan: payload.plan ?? undefined,
    planCells: payload.planCells,
    presentationTime: payload.presentationTimeIso,
    absolutePresentationSeconds: snapshot.presentationClock?.absolutePresentationSeconds,
    timeZone: binding.sceneTimeZone,
    latitude: snapshot.camera.latitude,
    longitude: snapshot.camera.longitude,
    quality: snapshot.rendererQuality,
    reducedMotion: snapshot.reducedMotion,
    layerVisibility: snapshot.activeLayers ? {
      buildings: snapshot.activeLayers.has('buildings'),
      infrastructure: snapshot.activeLayers.has('infrastructure'),
      weather: snapshot.activeLayers.has('weather'),
    } : undefined,
    weatherMode: snapshot.weather,
    weatherVisualOverride: snapshot.weatherVisualOverride ?? null,
    weatherIntensity: weatherSample?.intensity,
    weatherSample,
    weatherCyclePlayback: payload.weatherCyclePlayback ?? undefined,
    weatherBindingUnavailableReason: unavailableReason,
  };
}

export function instanceCapacityFor(required: number): number {
  const safeRequired = Math.max(1, Math.floor(required));
  return 2 ** Math.ceil(Math.log2(safeRequired));
}

export function canReuseInstanceCapacity(capacity: number, required: number): boolean {
  return capacity > 0 && required >= 0 && required <= capacity;
}

export const PROCEDURAL_ACTOR_PARTS = {
  person: ['torso', 'head', 'arms', 'legs'],
  vehicle: ['body', 'cabin', 'wheels', 'headlights'],
} as const;

const PERSON_PALETTE = [
  0x334155, 0x6b3f4b, 0x435844, 0x4b465f,
  0x7a4c3e, 0x6a7265, 0x26364a, 0x685b53,
] as const;
const VEHICLE_PALETTE = [
  0x8b3a3a, 0x324b3f, 0x39465e, 0x6d625b,
  0x6d3f66, 0x44484d, 0xb9b6aa, 0x56614b,
] as const;
const SKIN_PALETTE = [0xf0c7a5, 0xdba77f, 0xba7b55, 0x84543f] as const;
const SELECTED_ACTOR_COLOR = 0xe9f3df;

function mixActorSeed(seed: number): number {
  let value = seed >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

export function proceduralActorColor(
  seed: number,
  kind: 'person' | 'vehicle' | 'skin',
  selected = false,
): number {
  if (selected && kind !== 'skin') return SELECTED_ACTOR_COLOR;
  const palette = kind === 'person'
    ? PERSON_PALETTE
    : kind === 'vehicle'
      ? VEHICLE_PALETTE
      : SKIN_PALETTE;
  return palette[mixActorSeed(seed) % palette.length] ?? palette[0];
}

export interface ProceduralActorAnimation {
  readonly bodyBobMeters: number;
  readonly limbSwingRadians: number;
  readonly wheelSpinRadians: number;
  readonly vehicleRollRadians: number;
}

interface MutableProceduralActorAnimation {
  bodyBobMeters: number;
  limbSwingRadians: number;
  wheelSpinRadians: number;
  vehicleRollRadians: number;
}

function proceduralActorAnimationInto(
  target: MutableProceduralActorAnimation,
  seed: number,
  activity: VisualEntity['activity'] | number,
  absolutePresentationSeconds: number,
  reducedMotion: boolean,
): MutableProceduralActorAnimation {
  if (!Number.isFinite(absolutePresentationSeconds)) {
    throw new RangeError('Actor presentation clock must be finite');
  }
  if (reducedMotion) {
    target.bodyBobMeters = 0;
    target.limbSwingRadians = 0;
    target.wheelSpinRadians = 0;
    target.vehicleRollRadians = 0;
    return target;
  }
  const moving = activity === 'walk'
    || activity === 'transit'
    || activity === 'leisure'
    || activity === 1
    || activity === 3
    || activity === 4;
  const seedPhase = (mixActorSeed(seed) % 4_096) / 4_096 * Math.PI * 2;
  const walkPhase = absolutePresentationSeconds * Math.PI * 3.4 + seedPhase;
  target.bodyBobMeters = moving ? Math.abs(Math.sin(walkPhase)) * 0.035 : 0;
  target.limbSwingRadians = moving ? Math.sin(walkPhase) * 0.52 : 0;
  target.wheelSpinRadians = absolutePresentationSeconds * 3.8 + seedPhase;
  target.vehicleRollRadians = Math.sin(
    absolutePresentationSeconds * 2.1 + seedPhase,
  ) * 0.012;
  return target;
}

export function proceduralActorAnimation(
  seed: number,
  activity: VisualEntity['activity'] | number,
  absolutePresentationSeconds: number,
  reducedMotion: boolean,
): ProceduralActorAnimation {
  return proceduralActorAnimationInto({
    bodyBobMeters: 0,
    limbSwingRadians: 0,
    wheelSpinRadians: 0,
    vehicleRollRadians: 0,
  }, seed, activity, absolutePresentationSeconds, reducedMotion);
}

export interface ProceduralActorLodCaps {
  readonly animatedPeople: number;
  readonly animatedVehicles: number;
  readonly radialSegments: number;
}

export function proceduralActorLodCaps(quality: RendererQuality): ProceduralActorLodCaps {
  if (quality === 'performance') {
    return { animatedPeople: 2_000, animatedVehicles: 600, radialSegments: 5 };
  }
  if (quality === 'cinematic') {
    return { animatedPeople: 8_000, animatedVehicles: 2_000, radialSegments: 9 };
  }
  return { animatedPeople: 4_000, animatedVehicles: 1_200, radialSegments: 7 };
}

export interface DisposableActorResource {
  dispose(): void;
}

/** Disposes shared rig resources exactly once even when several parts reuse them. */
export function disposeUniqueActorResources(
  resources: Iterable<DisposableActorResource>,
): number {
  const uniqueResources = new Set(resources);
  uniqueResources.forEach((resource) => resource.dispose());
  return uniqueResources.size;
}

export interface ReusableActorPoseBuffer {
  count: number;
  capacity: number;
  allocations: number;
  ids: string[];
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  meters: Float64Array;
  headingRadians: Float32Array;
  seed: Uint32Array;
  selected: Uint8Array;
  activity: Uint8Array;
}

export function createReusableActorPoseBuffer(): ReusableActorPoseBuffer {
  return {
    count: 0,
    capacity: 0,
    allocations: 0,
    ids: [],
    x: new Float64Array(0),
    y: new Float64Array(0),
    z: new Float64Array(0),
    meters: new Float64Array(0),
    headingRadians: new Float32Array(0),
    seed: new Uint32Array(0),
    selected: new Uint8Array(0),
    activity: new Uint8Array(0),
  };
}

/** Grows geometrically and preserves slots; stable counts allocate zero hot-path storage. */
export function ensureReusableActorPoseCapacity(
  buffer: ReusableActorPoseBuffer,
  required: number,
): boolean {
  if (!Number.isInteger(required) || required < 0) {
    throw new RangeError('Actor pose capacity must be a non-negative integer');
  }
  if (required <= buffer.capacity) return false;
  const nextCapacity = instanceCapacityFor(required);
  const growFloat64 = (previous: Float64Array) => {
    const next = new Float64Array(nextCapacity);
    next.set(previous.subarray(0, buffer.count));
    return next;
  };
  const growFloat32 = (previous: Float32Array) => {
    const next = new Float32Array(nextCapacity);
    next.set(previous.subarray(0, buffer.count));
    return next;
  };
  const growUint32 = (previous: Uint32Array) => {
    const next = new Uint32Array(nextCapacity);
    next.set(previous.subarray(0, buffer.count));
    return next;
  };
  const growUint8 = (previous: Uint8Array) => {
    const next = new Uint8Array(nextCapacity);
    next.set(previous.subarray(0, buffer.count));
    return next;
  };
  const ids = new Array<string>(nextCapacity);
  for (let index = 0; index < buffer.count; index += 1) ids[index] = buffer.ids[index]!;
  buffer.ids = ids;
  buffer.x = growFloat64(buffer.x);
  buffer.y = growFloat64(buffer.y);
  buffer.z = growFloat64(buffer.z);
  buffer.meters = growFloat64(buffer.meters);
  buffer.headingRadians = growFloat32(buffer.headingRadians);
  buffer.seed = growUint32(buffer.seed);
  buffer.selected = growUint8(buffer.selected);
  buffer.activity = growUint8(buffer.activity);
  buffer.capacity = nextCapacity;
  buffer.allocations += 1;
  return true;
}

/**
 * Creates the shared-context Three.js layer used for instanced people and cars.
 * It is isolated behind an adapter so Canvas remains a first-class fallback.
 */
export async function createThreeEntityLayer(
  map: MapLibreMap,
  initialEntities: readonly VisualEntity[],
  initialSelectedId: string | null,
  quality: RendererQuality = 'adaptive',
  options: ThreeEntityLayerOptions = {},
): Promise<ThreeLayerAdapter> {
  const THREE = await import('three');
  let entities = initialEntities;
  let selectedId = initialSelectedId;
  let rendererSnapshot = options.initialScene;
  let renderer: InstanceType<typeof THREE.WebGLRenderer> | null = null;
  const camera = new THREE.Camera();
  const scene = new THREE.Scene();
  type ActorGeometry = Exclude<ConstructorParameters<typeof THREE.InstancedMesh>[0], undefined>;
  type ActorRig = {
    group: InstanceType<typeof THREE.Group>;
    meshes: Record<string, InstanceType<typeof THREE.InstancedMesh>>;
    geometries: Set<ActorGeometry>;
    materials: Set<InstanceType<typeof THREE.Material>>;
    capacity: number;
  };
  let peopleRig: ActorRig | null = null;
  let vehicleRig: ActorRig | null = null;
  const peoplePoses = createReusableActorPoseBuffer();
  const vehiclePoses = createReusableActorPoseBuffer();
  let actorPresentationSeconds = options.initialScene?.presentationClock
    ?.absolutePresentationSeconds ?? 0;
  let actorReducedMotion = options.initialScene?.reducedMotion ?? false;
  let disposed = false;
  let pedestrianCount = 0;
  let vehicleCount = 0;
  let submittedIds = initialEntities.map((entity) => entity.id);
  let renderedFrames = 0;
  let updateCount = 0;
  let rebuildCount = 0;
  const cityContribution = options.cityRendererV2 ? createCitySceneContribution() : null;
  let contributionController: AbortController | null = null;
  let peopleCapacity = 0;
  let vehicleCapacity = 0;
  const qualityProfile = rendererQualityProfile(quality, window.devicePixelRatio || 1);
  const actorCaps = proceduralActorLodCaps(quality);

  const actorFillLight = new THREE.HemisphereLight(0xd9e5f0, 0x4b514c, 0.48);
  actorFillLight.name = 'omnitwin-actor-fill-light';
  scene.add(actorFillLight);

  const disposeRig = (rig: ActorRig | null) => {
    if (!rig) return;
    scene.remove(rig.group);
    rig.group.clear();
    disposeUniqueActorResources(rig.geometries);
    disposeUniqueActorResources(rig.materials);
    rig.geometries.clear();
    rig.materials.clear();
  };

  const disposeMeshes = () => {
    disposeRig(peopleRig);
    disposeRig(vehicleRig);
    peopleRig = null;
    vehicleRig = null;
    peoplePoses.count = 0;
    vehiclePoses.count = 0;
    peopleCapacity = 0;
    vehicleCapacity = 0;
  };

  const createRigPart = (
    rig: ActorRig,
    key: string,
    geometry: ActorGeometry,
    material: InstanceType<typeof THREE.Material>,
    instanceCapacity: number,
  ) => {
    rig.geometries.add(geometry);
    rig.materials.add(material);
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, instanceCapacity));
    mesh.name = `omnitwin-${key}`;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    rig.group.add(mesh);
    rig.meshes[key] = mesh;
    return mesh;
  };

  const createPeopleRig = (capacity: number): ActorRig => {
    const group = new THREE.Group();
    group.name = 'omnitwin-procedural-people';
    const rig: ActorRig = {
      group,
      meshes: {},
      geometries: new Set(),
      materials: new Set(),
      capacity,
    };
    const clothing = new THREE.MeshStandardMaterial({
      name: 'omnitwin-person-clothing',
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.88,
      metalness: 0,
      flatShading: true,
    });
    const skin = new THREE.MeshStandardMaterial({
      name: 'omnitwin-person-skin',
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      flatShading: true,
    });
    const torso = new THREE.CylinderGeometry(0.27, 0.34, 0.78, actorCaps.radialSegments, 1);
    torso.rotateX(Math.PI / 2);
    const head = new THREE.SphereGeometry(
      0.22,
      actorCaps.radialSegments,
      Math.max(4, Math.floor(actorCaps.radialSegments * 0.66)),
    );
    const limb = new THREE.CylinderGeometry(0.07, 0.085, 0.66, actorCaps.radialSegments, 1);
    limb.rotateX(Math.PI / 2);
    createRigPart(rig, 'person-torsos', torso, clothing, capacity);
    createRigPart(rig, 'person-heads', head, skin, capacity);
    createRigPart(rig, 'person-arms', limb, clothing, capacity * 2);
    createRigPart(rig, 'person-legs', limb, clothing, capacity * 2);
    scene.add(group);
    return rig;
  };

  const createVehicleRig = (capacity: number): ActorRig => {
    const group = new THREE.Group();
    group.name = 'omnitwin-procedural-vehicles';
    const rig: ActorRig = {
      group,
      meshes: {},
      geometries: new Set(),
      materials: new Set(),
      capacity,
    };
    const paint = new THREE.MeshStandardMaterial({
      name: 'omnitwin-vehicle-paint',
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.56,
      metalness: 0.16,
      flatShading: true,
    });
    const glass = new THREE.MeshStandardMaterial({
      name: 'omnitwin-vehicle-glass',
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.24,
      metalness: 0.22,
      flatShading: true,
    });
    const tire = new THREE.MeshStandardMaterial({
      name: 'omnitwin-vehicle-tire',
      color: 0x202426,
      roughness: 0.96,
      metalness: 0,
      flatShading: true,
    });
    const lamp = new THREE.MeshStandardMaterial({
      name: 'omnitwin-vehicle-lamp',
      color: 0xe8eef0,
      emissive: 0xc9d8dc,
      emissiveIntensity: 0.7,
      roughness: 0.28,
    });
    const body = new THREE.BoxGeometry(4.2, 1.78, 0.56);
    const cabin = new THREE.BoxGeometry(2.15, 1.52, 0.7);
    const wheel = new THREE.CylinderGeometry(0.34, 0.18, actorCaps.radialSegments, 1);
    const headlight = new THREE.SphereGeometry(0.14, actorCaps.radialSegments, 4);
    createRigPart(rig, 'vehicle-bodies', body, paint, capacity);
    createRigPart(rig, 'vehicle-cabins', cabin, glass, capacity);
    createRigPart(rig, 'vehicle-wheels', wheel, tire, capacity * 4);
    createRigPart(rig, 'vehicle-headlights', headlight, lamp, capacity * 2);
    scene.add(group);
    return rig;
  };

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const headingQuaternion = new THREE.Quaternion();
  const localQuaternion = new THREE.Quaternion();
  const axisQuaternion = new THREE.Quaternion();
  const finalQuaternion = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const xAxis = new THREE.Vector3(1, 0, 0);
  const yAxis = new THREE.Vector3(0, 1, 0);
  const instanceColor = new THREE.Color();
  const animationState: MutableProceduralActorAnimation = {
    bodyBobMeters: 0,
    limbSwingRadians: 0,
    wheelSpinRadians: 0,
    vehicleRollRadians: 0,
  };

  const writeActorPart = (
    mesh: InstanceType<typeof THREE.InstancedMesh>,
    index: number,
    poses: ReusableActorPoseBuffer,
    poseIndex: number,
    localForward: number,
    localSide: number,
    localUp: number,
    rotationX = 0,
    rotationY = 0,
    colorHex?: number,
  ) => {
    const poseMeters = poses.meters[poseIndex]!;
    const poseHeading = poses.headingRadians[poseIndex]!;
    const selectedScale = poses.selected[poseIndex] === 1 ? 1.08 : 1;
    const cosine = Math.cos(poseHeading);
    const sine = Math.sin(poseHeading);
    position.set(
      poses.x[poseIndex]!
        + (localForward * cosine + localSide * sine) * poseMeters * selectedScale,
      poses.y[poseIndex]!
        + (-localForward * sine + localSide * cosine) * poseMeters * selectedScale,
      poses.z[poseIndex]! + localUp * poseMeters * selectedScale,
    );
    headingQuaternion.setFromAxisAngle(zAxis, -poseHeading);
    localQuaternion.identity();
    if (rotationX !== 0) {
      axisQuaternion.setFromAxisAngle(xAxis, rotationX);
      localQuaternion.multiply(axisQuaternion);
    }
    if (rotationY !== 0) {
      axisQuaternion.setFromAxisAngle(yAxis, rotationY);
      localQuaternion.multiply(axisQuaternion);
    }
    finalQuaternion.copy(headingQuaternion).multiply(localQuaternion);
    scale.setScalar(poseMeters * selectedScale);
    matrix.compose(position, finalQuaternion, scale);
    mesh.setMatrixAt(index, matrix);
    if (colorHex !== undefined) {
      instanceColor.setHex(colorHex);
      mesh.setColorAt(index, instanceColor);
    }
  };

  const markActorMeshUpdated = (
    mesh: InstanceType<typeof THREE.InstancedMesh>,
    updatedInstances: number,
    colorsUpdated: boolean,
  ) => {
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, updatedInstances * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (colorsUpdated && mesh.instanceColor) {
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, updatedInstances * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  };

  const renderPeople = (
    maximum = peoplePoses.count,
    colorsUpdated = true,
  ) => {
    if (!peopleRig) return;
    const torsos = peopleRig.meshes['person-torsos']!;
    const heads = peopleRig.meshes['person-heads']!;
    const arms = peopleRig.meshes['person-arms']!;
    const legs = peopleRig.meshes['person-legs']!;
    torsos.count = peoplePoses.count;
    heads.count = peoplePoses.count;
    arms.count = peoplePoses.count * 2;
    legs.count = peoplePoses.count * 2;
    const limit = Math.min(maximum, peoplePoses.count);
    for (let index = 0; index < limit; index += 1) {
      const seed = peoplePoses.seed[index]!;
      const animation = proceduralActorAnimationInto(
        animationState,
        seed,
        peoplePoses.activity[index]!,
        actorPresentationSeconds,
        actorReducedMotion,
      );
      const selected = peoplePoses.selected[index] === 1;
      const clothing = proceduralActorColor(seed, 'person', selected);
      const skin = proceduralActorColor(seed, 'skin');
      writeActorPart(torsos, index, peoplePoses, index, 0, 0, 1.03 + animation.bodyBobMeters, 0, animation.limbSwingRadians * 0.04, colorsUpdated ? clothing : undefined);
      writeActorPart(heads, index, peoplePoses, index, 0, 0, 1.62 + animation.bodyBobMeters, 0, 0, colorsUpdated ? skin : undefined);
      for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
        const side = sideIndex === 0 ? -1 : 1;
        const pairIndex = index * 2 + sideIndex;
        const swing = animation.limbSwingRadians * side;
        writeActorPart(legs, pairIndex, peoplePoses, index, 0, side * 0.14, 0.42 + animation.bodyBobMeters * 0.45, 0, swing, colorsUpdated ? clothing : undefined);
        writeActorPart(arms, pairIndex, peoplePoses, index, 0, side * 0.36, 1.05 + animation.bodyBobMeters, 0, -swing, colorsUpdated ? clothing : undefined);
      }
    }
    markActorMeshUpdated(torsos, limit, colorsUpdated);
    markActorMeshUpdated(heads, limit, colorsUpdated);
    markActorMeshUpdated(arms, limit * 2, colorsUpdated);
    markActorMeshUpdated(legs, limit * 2, colorsUpdated);
  };

  const renderVehicles = (
    maximum = vehiclePoses.count,
    colorsUpdated = true,
  ) => {
    if (!vehicleRig) return;
    const bodies = vehicleRig.meshes['vehicle-bodies']!;
    const cabins = vehicleRig.meshes['vehicle-cabins']!;
    const wheels = vehicleRig.meshes['vehicle-wheels']!;
    const headlights = vehicleRig.meshes['vehicle-headlights']!;
    bodies.count = vehiclePoses.count;
    cabins.count = vehiclePoses.count;
    wheels.count = vehiclePoses.count * 4;
    headlights.count = vehiclePoses.count * 2;
    const limit = Math.min(maximum, vehiclePoses.count);
    for (let index = 0; index < limit; index += 1) {
      const seed = vehiclePoses.seed[index]!;
      const animation = proceduralActorAnimationInto(
        animationState,
        seed,
        'transit',
        actorPresentationSeconds,
        actorReducedMotion,
      );
      const selected = vehiclePoses.selected[index] === 1;
      const paint = proceduralActorColor(seed, 'vehicle', selected);
      const glass = selected ? SELECTED_ACTOR_COLOR : 0x34434b;
      writeActorPart(bodies, index, vehiclePoses, index, 0, 0, 0.62 + animation.bodyBobMeters * 0.2, animation.vehicleRollRadians, 0, colorsUpdated ? paint : undefined);
      writeActorPart(cabins, index, vehiclePoses, index, -0.34, 0, 1.18 + animation.bodyBobMeters * 0.2, animation.vehicleRollRadians, 0, colorsUpdated ? glass : undefined);
      let wheelIndex = index * 4;
      for (let forwardIndex = 0; forwardIndex < 2; forwardIndex += 1) {
        const forward = forwardIndex === 0 ? -1.38 : 1.38;
        for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
          const side = sideIndex === 0 ? -0.96 : 0.96;
          writeActorPart(wheels, wheelIndex, vehiclePoses, index, forward, side, 0.36, 0, animation.wheelSpinRadians);
          wheelIndex += 1;
        }
      }
      for (let sideIndex = 0; sideIndex < 2; sideIndex += 1) {
        const side = sideIndex === 0 ? -0.58 : 0.58;
        const lightIndex = index * 2 + sideIndex;
        writeActorPart(headlights, lightIndex, vehiclePoses, index, 2.12, side, 0.66);
      }
    }
    markActorMeshUpdated(bodies, limit, colorsUpdated);
    markActorMeshUpdated(cabins, limit, colorsUpdated);
    markActorMeshUpdated(wheels, limit * 4, colorsUpdated);
    markActorMeshUpdated(headlights, limit * 2, colorsUpdated);
  };

  const renderActorAnimation = (fullUpdate = false) => {
    if (disposed) return;
    renderPeople(
      fullUpdate ? peoplePoses.count : actorCaps.animatedPeople,
      fullUpdate,
    );
    renderVehicles(
      fullUpdate ? vehiclePoses.count : actorCaps.animatedVehicles,
      fullUpdate,
    );
  };

  const writePose = (
    buffer: ReusableActorPoseBuffer,
    index: number,
    id: string,
    longitude: number,
    latitude: number,
    headingDegrees: number,
    seed: number,
    activity: VisualEntity['activity'] | number,
  ) => {
    const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
    const latitudeRadians = clampedLatitude * Math.PI / 180;
    buffer.ids[index] = id;
    buffer.x[index] = (longitude + 180) / 360;
    buffer.y[index] = (
      1 - Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) / Math.PI
    ) / 2;
    buffer.z[index] = 0;
    buffer.meters[index] = 1 / (40_075_016.68557849 * Math.cos(latitudeRadians));
    buffer.headingRadians[index] = headingDegrees * Math.PI / 180;
    buffer.seed[index] = seed;
    buffer.selected[index] = id === selectedId ? 1 : 0;
    buffer.activity[index] = typeof activity === 'number'
      ? activity
      : activity === 'walk'
        ? 1
        : activity === 'work'
          ? 2
          : activity === 'study'
            ? 5
          : activity === 'ambient'
            ? 3
          : activity === 'transit'
            ? 3
            : activity === 'leisure'
              ? 4
              : 0;
  };

  const rebuildRigIfRequired = (
    kind: 'people' | 'vehicles',
    required: number,
  ): boolean => {
    if (kind === 'people') {
      if (peopleRig && canReuseInstanceCapacity(peopleCapacity, required)) return false;
      disposeRig(peopleRig);
      peopleCapacity = instanceCapacityFor(required);
      peopleRig = createPeopleRig(peopleCapacity);
      return true;
    }
    if (vehicleRig && canReuseInstanceCapacity(vehicleCapacity, required)) return false;
    disposeRig(vehicleRig);
    vehicleCapacity = instanceCapacityFor(required);
    vehicleRig = createVehicleRig(vehicleCapacity);
    return true;
  };

  const syncMeshes = () => {
    if (disposed) return;
    let requiredPeople = 0;
    let requiredVehicles = 0;
    submittedIds.length = entities.length;
    for (let index = 0; index < entities.length; index += 1) {
      const entity = entities[index]!;
      submittedIds[index] = entity.id;
      if (entity.kind === 'vehicle') requiredVehicles += 1;
      else requiredPeople += 1;
    }
    ensureReusableActorPoseCapacity(peoplePoses, requiredPeople);
    ensureReusableActorPoseCapacity(vehiclePoses, requiredVehicles);
    let personIndex = 0;
    let vehicleIndex = 0;
    for (const entity of entities) {
      const target = entity.kind === 'vehicle' ? vehiclePoses : peoplePoses;
      const targetIndex = entity.kind === 'vehicle' ? vehicleIndex++ : personIndex++;
      writePose(
        target,
        targetIndex,
        entity.id,
        entity.longitude,
        entity.latitude,
        entity.heading,
        entity.seed,
        entity.activity,
      );
    }
    peoplePoses.count = requiredPeople;
    vehiclePoses.count = requiredVehicles;
    pedestrianCount = requiredPeople;
    vehicleCount = requiredVehicles;
    const peopleRebuilt = rebuildRigIfRequired('people', requiredPeople);
    const vehicleRebuilt = rebuildRigIfRequired('vehicles', requiredVehicles);
    if (peopleRebuilt || vehicleRebuilt) rebuildCount += 1;
    renderActorAnimation(true);
    map.triggerRepaint();
  };

  const syncLivingMeshes = (living: RendererLivingSnapshot) => {
    if (disposed) return;
    const { partition } = living;
    let requiredPeople = 0;
    let requiredVehicles = 0;
    let submittedCount = 0;
    for (let index = 0; index < partition.count; index += 1) {
      if (partition.presentation.primaryRenderer[index] !== LivingPrimaryRenderer.THREE) continue;
      submittedIds[submittedCount] = partition.identity.ids[index]!;
      submittedCount += 1;
      if (partition.identity.kind[index] === LivingKind.VEHICLE) requiredVehicles += 1;
      else requiredPeople += 1;
    }
    submittedIds.length = submittedCount;
    ensureReusableActorPoseCapacity(peoplePoses, requiredPeople);
    ensureReusableActorPoseCapacity(vehiclePoses, requiredVehicles);
    const longitudeMeters = Math.max(
      1,
      Math.cos(partition.originLatitude * Math.PI / 180) * 111_320,
    );
    let personIndex = 0;
    let vehicleIndex = 0;
    for (let index = 0; index < partition.count; index += 1) {
      if (partition.presentation.primaryRenderer[index] !== LivingPrimaryRenderer.THREE) continue;
      const id = partition.identity.ids[index]!;
      const longitude = ((
        partition.originLongitude + living.frame.x[index]! / longitudeMeters + 540
      ) % 360) - 180;
      const latitude = partition.originLatitude + living.frame.y[index]! / 110_540;
      const vehicle = partition.identity.kind[index] === LivingKind.VEHICLE;
      const target = vehicle ? vehiclePoses : peoplePoses;
      const targetIndex = vehicle ? vehicleIndex++ : personIndex++;
      writePose(
        target,
        targetIndex,
        id,
        longitude,
        latitude,
        living.frame.heading[index]!,
        partition.identity.seed[index]!,
        living.frame.activity[index]!,
      );
    }
    peoplePoses.count = requiredPeople;
    vehiclePoses.count = requiredVehicles;
    pedestrianCount = requiredPeople;
    vehicleCount = requiredVehicles;
    const peopleRebuilt = rebuildRigIfRequired('people', requiredPeople);
    const vehicleRebuilt = rebuildRigIfRequired('vehicles', requiredVehicles);
    if (peopleRebuilt || vehicleRebuilt) rebuildCount += 1;
    renderActorAnimation(true);
    map.triggerRepaint();
  };

  const updateCityContribution = () => {
    if (!cityContribution || !rendererSnapshot) return;
    const citySnapshot = citySnapshotFromRenderer(rendererSnapshot);
    if (citySnapshot) cityContribution.update(citySnapshot);
  };

  updateCityContribution();

  const layer: CustomLayerInterface = {
    id: 'omnitwin-three-entities',
    type: 'custom',
    renderingMode: '3d',
    onAdd(_map, gl) {
      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: qualityProfile.antialiasThree,
      });
      renderer.autoClear = false;
      if (cityContribution) {
        contributionController?.abort();
        contributionController = new AbortController();
        cityContribution.attach({
          THREE,
          scene,
          camera,
          renderer,
          map,
          requestRepaint: () => map.triggerRepaint(),
        }, contributionController.signal);
      }
      syncMeshes();
    },
    render(_gl, options: CustomRenderMethodInput) {
      if (!renderer || disposed) return;
      renderedFrames += 1;
      camera.projectionMatrix.fromArray(
        options.defaultProjectionData.mainMatrix as unknown as number[],
      );
      renderer.resetState();
      renderer.render(scene, camera);
    },
    onRemove() {
      contributionController?.abort();
      contributionController = null;
      disposeMeshes();
      renderer?.dispose();
      renderer = null;
    },
  };

  return {
    kind: 'three',
    layer,
    update(nextEntities, nextSelectedId) {
      entities = nextEntities;
      selectedId = nextSelectedId;
      updateCount += 1;
      syncMeshes();
    },
    updateScene(nextSnapshot) {
      rendererSnapshot = nextSnapshot;
      selectedId = nextSnapshot.selectedId;
      actorPresentationSeconds = nextSnapshot.presentationClock
        ?.absolutePresentationSeconds ?? actorPresentationSeconds;
      actorReducedMotion = nextSnapshot.reducedMotion;
      for (let index = 0; index < peoplePoses.count; index += 1) {
        peoplePoses.selected[index] = peoplePoses.ids[index] === selectedId ? 1 : 0;
      }
      for (let index = 0; index < vehiclePoses.count; index += 1) {
        vehiclePoses.selected[index] = vehiclePoses.ids[index] === selectedId ? 1 : 0;
      }
      renderActorAnimation(true);
      updateCityContribution();
      map.triggerRepaint();
    },
    updateLiving(nextLiving, nextSelectedId) {
      selectedId = nextSelectedId;
      updateCount += 1;
      syncLivingMeshes(nextLiving);
    },
    frame(frame) {
      actorPresentationSeconds = frame.absolutePresentationSeconds;
      actorReducedMotion = frame.reducedMotion;
      renderActorAnimation(false);
      cityContribution?.frame(frame);
    },
    dispose() {
      disposed = true;
      contributionController?.abort();
      contributionController = null;
      cityContribution?.dispose();
      if (map.getLayer(layer.id)) map.removeLayer(layer.id);
      else disposeMeshes();
      scene.remove(actorFillLight);
    },
    telemetry() {
      return {
        pedestrians: pedestrianCount,
        vehicles: vehicleCount,
        renderedFrames,
        updates: updateCount,
        rebuilds: rebuildCount,
        actorPoseAllocations: peoplePoses.allocations + vehiclePoses.allocations,
        actorPoseCapacity: {
          people: peoplePoses.capacity,
          vehicles: vehiclePoses.capacity,
        },
        contributions: cityContribution ? [cityContribution.telemetry()] : undefined,
        submittedIds,
      };
    },
  };
}
