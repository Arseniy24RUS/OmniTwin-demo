import type * as Three from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createDeterministicRng } from '../rng';
import type { LivingCityQualityCaps } from '../environment/qualityCaps';
import type { EnvironmentSceneState } from '../environment/environmentScene';
import { BUILDING_ARCHETYPES, RUSSIAN_FACADE_PALETTE } from './archetypes';
import type {
  CityBuilding,
  CityDistrictPlan,
  CityRoute,
  CityVehicle,
  PointMeters,
} from './types';

interface InstanceSpec {
  readonly east: number;
  readonly north: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly rotationRadians?: number;
  readonly color?: number;
}

interface PreparedRoute {
  readonly id: string;
  readonly points: readonly PointMeters[];
  readonly segmentLengths: readonly number[];
  readonly cumulativeLengths: readonly number[];
  readonly totalLength: number;
}

export interface CityGeometryStats {
  readonly buildings: number;
  readonly trees: number;
  readonly props: number;
  readonly vehicles: number;
  readonly drawGroups: number;
}

export interface CityGeometryController {
  readonly group: Three.Group;
  readonly stats: CityGeometryStats;
  updateEnvironment: (state: EnvironmentSceneState) => void;
  setPresentationTime: (presentationTimeMs: number) => void;
  setReducedMotion: (reducedMotion: boolean) => void;
  setLayerVisibility: (visibility: {
    readonly buildings: boolean;
    readonly infrastructure: boolean;
  }) => void;
  frame: (deltaMilliseconds: number) => void;
  dispose: () => void;
}

interface CityGeometryOptions {
  readonly THREE: typeof import('three');
  readonly plan: CityDistrictPlan;
  readonly qualityCaps: LivingCityQualityCaps;
}

const VEHICLE_COLORS = [
  0x456274, 0x8a3f37, 0xc2b8a3, 0x31564f,
  0x6a6f75, 0xa67b42, 0x34405c, 0xe0ddd2,
] as const;

function localToDistrict(
  building: CityBuilding,
  localEast: number,
  localNorth: number,
): PointMeters {
  const cosine = Math.cos(building.rotationRadians);
  const sine = Math.sin(building.rotationRadians);
  return {
    east: building.center.east + localEast * cosine - localNorth * sine,
    north: building.center.north + localEast * sine + localNorth * cosine,
  };
}

function prepareRoute(route: CityRoute): PreparedRoute {
  const points = route.closed && route.points.length > 1
    ? [...route.points, route.points[0] as PointMeters]
    : [...route.points];
  const segmentLengths: number[] = [];
  const cumulativeLengths: number[] = [0];
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index] as PointMeters;
    const next = points[index + 1] as PointMeters;
    const length = Math.hypot(next.east - current.east, next.north - current.north);
    segmentLengths.push(length);
    cumulativeLengths.push((cumulativeLengths[index] ?? 0) + length);
  }
  return {
    id: route.id,
    points,
    segmentLengths,
    cumulativeLengths,
    totalLength: cumulativeLengths.at(-1) ?? 0,
  };
}

function sampleRoute(route: PreparedRoute, distance: number) {
  if (route.totalLength <= 0 || route.points.length < 2) {
    return { east: 0, north: 0, heading: 0 };
  }
  const normalizedDistance = ((distance % route.totalLength) + route.totalLength) % route.totalLength;
  let segmentIndex = 0;
  while (
    segmentIndex < route.segmentLengths.length - 1
    && normalizedDistance > (route.cumulativeLengths[segmentIndex + 1] ?? route.totalLength)
  ) {
    segmentIndex += 1;
  }
  const current = route.points[segmentIndex] as PointMeters;
  const next = route.points[segmentIndex + 1] as PointMeters;
  const segmentStart = route.cumulativeLengths[segmentIndex] ?? 0;
  const segmentLength = route.segmentLengths[segmentIndex] ?? 1;
  const amount = Math.max(0, Math.min(1, (normalizedDistance - segmentStart) / segmentLength));
  return {
    east: current.east + (next.east - current.east) * amount,
    north: current.north + (next.north - current.north) * amount,
    heading: Math.atan2(next.north - current.north, next.east - current.east),
  };
}

function linePoints(
  item: { readonly center: PointMeters; readonly orientation: 'east_west' | 'north_south'; readonly length: number; readonly points?: readonly PointMeters[] },
): readonly PointMeters[] {
  if (item.points && item.points.length >= 2) return item.points;
  const half = item.length / 2;
  return item.orientation === 'east_west'
    ? [
        { east: item.center.east - half, north: item.center.north },
        { east: item.center.east + half, north: item.center.north },
      ]
    : [
        { east: item.center.east, north: item.center.north - half },
        { east: item.center.east, north: item.center.north + half },
      ];
}

function segmentSpecs(
  points: readonly PointMeters[],
  width: number,
  z: number,
  height: number,
  lateralOffset = 0,
): InstanceSpec[] {
  const specs: InstanceSpec[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    const deltaEast = next.east - current.east;
    const deltaNorth = next.north - current.north;
    const length = Math.hypot(deltaEast, deltaNorth);
    if (length <= 0.01) continue;
    const normalEast = -deltaNorth / length;
    const normalNorth = deltaEast / length;
    specs.push({
      east: (current.east + next.east) / 2 + normalEast * lateralOffset,
      north: (current.north + next.north) / 2 + normalNorth * lateralOffset,
      z,
      // Slight overlap closes visual pinholes at authored polyline joins.
      width: length + width * 0.35,
      depth: width,
      height,
      rotationRadians: Math.atan2(deltaNorth, deltaEast),
    });
  }
  return specs;
}

function dashedLineSpecs(
  points: readonly PointMeters[],
  lateralOffset: number,
): InstanceSpec[] {
  const route = prepareRoute({ id: 'marking', points, closed: false });
  const specs: InstanceSpec[] = [];
  for (let distance = 5; distance < route.totalLength - 3; distance += 13) {
    const center = sampleRoute(route, distance);
    const normalEast = -Math.sin(center.heading);
    const normalNorth = Math.cos(center.heading);
    specs.push({
      east: center.east + normalEast * lateralOffset,
      north: center.north + normalNorth * lateralOffset,
      z: 0.035,
      width: 6,
      depth: 0.14,
      height: 0.025,
      rotationRadians: center.heading,
    });
  }
  return specs;
}

export function createCityGeometryController(
  options: CityGeometryOptions,
): CityGeometryController {
  const { THREE, qualityCaps } = options;
  const plan = options.plan;
  const group = new THREE.Group();
  group.name = `omnitwin-city:${plan.id}`;
  const buildingLayer = new THREE.Group();
  buildingLayer.name = 'omnitwin-city-buildings-layer';
  const infrastructureLayer = new THREE.Group();
  infrastructureLayer.name = 'omnitwin-city-infrastructure-layer';
  group.add(buildingLayer, infrastructureLayer);
  const geometries = new Set<Three.BufferGeometry>();
  const materials = new Set<Three.Material>();
  const meshes: Three.Object3D[] = [];
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const color = new THREE.Color();

  const ownGeometry = <T extends Three.BufferGeometry>(geometry: T): T => {
    geometries.add(geometry);
    return geometry;
  };
  const ownMaterial = <T extends Three.Material>(material: T): T => {
    materials.add(material);
    return material;
  };

  const writeInstance = (mesh: Three.InstancedMesh, index: number, spec: InstanceSpec) => {
    position.set(spec.east, -spec.north, spec.z + spec.height / 2);
    quaternion.setFromAxisAngle(zAxis, -(spec.rotationRadians ?? 0));
    scale.set(spec.width, spec.depth, spec.height);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
    if (spec.color !== undefined) {
      color.setHex(spec.color);
      mesh.setColorAt(index, color);
    }
  };

  const batchParent = (name: string): Three.Group => {
    if (
      name.startsWith('building-')
      || name.startsWith('source-building-')
      || name.startsWith('windows-')
    ) return buildingLayer;
    if (name === 'ground') return group;
    return infrastructureLayer;
  };

  const createBoxBatch = (
    name: string,
    specs: readonly InstanceSpec[],
    material: Three.Material,
    shadows: 'none' | 'receive' | 'cast_receive' = 'none',
    dynamic = false,
  ): Three.InstancedMesh => {
    const geometry = ownGeometry(new THREE.BoxGeometry(1, 1, 1));
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, specs.length));
    mesh.name = name;
    mesh.count = specs.length;
    mesh.castShadow = shadows === 'cast_receive' && qualityCaps.dynamicShadows;
    mesh.receiveShadow = shadows !== 'none' && qualityCaps.dynamicShadows;
    mesh.instanceMatrix.setUsage(dynamic ? THREE.DynamicDrawUsage : THREE.StaticDrawUsage);
    specs.forEach((spec, index) => writeInstance(mesh, index, spec));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    batchParent(name).add(mesh);
    meshes.push(mesh);
    return mesh;
  };

  const createGeometryBatch = (
    name: string,
    geometry: Three.BufferGeometry,
    specs: readonly InstanceSpec[],
    material: Three.Material,
  ): Three.InstancedMesh => {
    ownGeometry(geometry);
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, specs.length));
    mesh.name = name;
    mesh.count = specs.length;
    mesh.castShadow = qualityCaps.dynamicShadows;
    mesh.receiveShadow = qualityCaps.dynamicShadows;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    specs.forEach((spec, index) => writeInstance(mesh, index, spec));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    batchParent(name).add(mesh);
    meshes.push(mesh);
    return mesh;
  };

  const groundMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-ground',
    color: 0x74806a,
    roughness: 0.96,
    metalness: 0,
  }));
  createBoxBatch('ground', [{
    east: 0,
    north: 0,
    z: -0.35,
    width: plan.bounds.width,
    depth: plan.bounds.height,
    height: 0.3,
  }], groundMaterial, 'receive');

  const roadMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-road-asphalt',
    color: 0x33383b,
    roughness: 0.9,
    metalness: 0.02,
  }));
  const roadSpecs = plan.roads.flatMap((item) =>
    segmentSpecs(linePoints(item), item.width, -0.04, 0.12));
  createBoxBatch('roads', roadSpecs, roadMaterial, 'receive');

  const sidewalkMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-sidewalk',
    color: 0xa7a294,
    roughness: 0.98,
  }));
  const sidewalkSpecs = plan.sidewalks.flatMap((item) =>
    segmentSpecs(linePoints(item), item.width, 0.02, 0.16));
  createBoxBatch('sidewalks', sidewalkSpecs, sidewalkMaterial, 'receive');

  const kerbMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-kerb',
    color: 0xd1ccc0,
    roughness: 0.92,
  }));
  const kerbSpecs = plan.sidewalks.flatMap((item): readonly InstanceSpec[] => [
    ...segmentSpecs(linePoints(item), 0.22, 0.09, 0.18, item.width / 2),
    ...segmentSpecs(linePoints(item), 0.22, 0.09, 0.18, -item.width / 2),
  ]);
  createBoxBatch('kerbs', kerbSpecs, kerbMaterial, 'receive');

  const markingMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-road-marking',
    color: 0xe8e2c9,
    roughness: 0.78,
  }));
  const markingSpecs: InstanceSpec[] = [];
  for (const item of plan.roads) {
    const dividerOffsets = item.laneCount > 2 ? [-item.width / 4, item.width / 4] : [0];
    for (const divider of dividerOffsets) {
      markingSpecs.push(...dashedLineSpecs(linePoints(item), divider));
    }
  }
  for (const crossing of plan.crosswalks) {
    const points = linePoints(crossing);
    const route = prepareRoute({ id: crossing.id, points, closed: false });
    const pitch = route.totalLength / crossing.stripeCount;
    for (let stripe = 0; stripe < crossing.stripeCount; stripe += 1) {
      const center = sampleRoute(route, pitch * (stripe + 0.5));
      markingSpecs.push({
        east: center.east,
        north: center.north,
        z: 0.055,
        width: pitch * 0.58,
        depth: crossing.width,
        height: 0.026,
        rotationRadians: center.heading,
      });
    }
  }
  createBoxBatch('lane-markings-and-crosswalks', markingSpecs, markingMaterial, 'receive');

  const visibleBuildings = plan.buildings.slice(0, qualityCaps.maxBuildings);
  const buildingMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-building-facades',
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.84,
    metalness: 0.01,
  }));
  const rectangularBuildings = visibleBuildings.filter((building) => !building.footprint
    || building.footprint.length < 3);
  const buildingSpecs = rectangularBuildings.map((building): InstanceSpec => ({
    east: building.center.east,
    north: building.center.north,
    z: 0,
    width: building.width,
    depth: building.depth,
    height: building.height,
    rotationRadians: building.rotationRadians,
    color: RUSSIAN_FACADE_PALETTE[building.facadePaletteIndex % RUSSIAN_FACADE_PALETTE.length]?.facade
      ?? 0xc8c4b5,
  }));
  createBoxBatch('building-shells', buildingSpecs, buildingMaterial, 'cast_receive');

  const footprintGroups = new Map<number, Three.BufferGeometry[]>();
  for (const building of visibleBuildings) {
    if (!building.footprint || building.footprint.length < 3) continue;
    const footprint = [...building.footprint];
    const first = footprint[0]!;
    const last = footprint.at(-1)!;
    if (footprint.length > 3 && first.east === last.east && first.north === last.north) {
      footprint.pop();
    }
    if (footprint.length < 3) continue;
    const shape = new THREE.Shape();
    shape.moveTo(footprint[0]!.east, -footprint[0]!.north);
    for (const point of footprint.slice(1)) shape.lineTo(point.east, -point.north);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: building.height,
      bevelEnabled: false,
      steps: 1,
      curveSegments: 1,
    });
    geometry.computeVertexNormals();
    const paletteIndex = building.facadePaletteIndex % RUSSIAN_FACADE_PALETTE.length;
    const bucket = footprintGroups.get(paletteIndex) ?? [];
    bucket.push(geometry);
    footprintGroups.set(paletteIndex, bucket);
  }
  for (const [paletteIndex, sourceGeometries] of footprintGroups) {
    const merged = mergeGeometries(sourceGeometries, false);
    sourceGeometries.forEach((geometry) => geometry.dispose());
    if (!merged) throw new Error('Source building footprints could not be batched');
    ownGeometry(merged);
    const palette = RUSSIAN_FACADE_PALETTE[paletteIndex] ?? RUSSIAN_FACADE_PALETTE[0];
    const material = ownMaterial(new THREE.MeshStandardMaterial({
      name: `omnitwin-source-building-facades-${paletteIndex}`,
      color: palette?.facade ?? 0xc8c4b5,
      roughness: 0.84,
      metalness: 0.01,
    }));
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `source-building-shells-${paletteIndex}`;
    mesh.castShadow = qualityCaps.dynamicShadows;
    mesh.receiveShadow = qualityCaps.dynamicShadows;
    buildingLayer.add(mesh);
    meshes.push(mesh);
  }

  const accentMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-building-accents',
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.8,
  }));
  const accentSpecs: InstanceSpec[] = [];
  const flatRoofSpecs: InstanceSpec[] = [];
  const hipRoofSpecs: InstanceSpec[] = [];
  const gableRoofSpecs: InstanceSpec[] = [];
  const sawtoothRoofSpecs: InstanceSpec[] = [];
  for (const building of visibleBuildings) {
    const palette = RUSSIAN_FACADE_PALETTE[
      building.facadePaletteIndex % RUSSIAN_FACADE_PALETTE.length
    ] ?? RUSSIAN_FACADE_PALETTE[0];
    if (!palette) continue;
    const definition = BUILDING_ARCHETYPES[building.archetype];
    const front = localToDistrict(building, 0, -building.depth / 2 - 0.26);
    const accentHeight = building.archetype === 'stalinist' ? 0.65
      : building.archetype === 'industrial' ? 1.1
        : building.archetype === 'commercial_pavilion' ? building.height * 0.42
          : Math.min(1.2, building.height * 0.08);
    accentSpecs.push({
      east: front.east,
      north: front.north,
      z: building.archetype === 'commercial_pavilion' ? 0.5 : building.height - accentHeight,
      width: building.width * (1 + definition.setbackRatio * 0.12),
      depth: 0.42,
      height: accentHeight,
      rotationRadians: building.rotationRadians,
      color: palette.secondary,
    });
    if (building.archetype === 'tower_16') {
      accentSpecs.push({
        east: building.center.east,
        north: building.center.north,
        z: 0,
        width: building.width * 1.34,
        depth: building.depth * 1.28,
        height: 3.8,
        rotationRadians: building.rotationRadians,
        color: palette.secondary,
      });
    }
    if (building.archetype === 'panel_9' || building.archetype === 'panel_5') {
      const core = localToDistrict(building, building.width * 0.18, -building.depth / 2 - 0.34);
      accentSpecs.push({
        east: core.east,
        north: core.north,
        z: 0.2,
        width: 3.2,
        depth: 0.68,
        height: building.height - 0.4,
        rotationRadians: building.rotationRadians,
        color: palette.secondary,
      });
    }
    const roofHeight = building.roofStyle === 'flat' ? 0.25
      : building.roofStyle === 'parapet' ? 0.7
        : building.roofStyle === 'sawtooth' ? 1.6 : 2.4;
    const roofSpec: InstanceSpec = {
      east: building.center.east,
      north: building.center.north,
      z: building.height,
      width: building.width * 1.03,
      depth: building.depth * 1.03,
      height: roofHeight,
      rotationRadians: building.rotationRadians,
      color: palette.roof,
    };
    if (building.roofStyle === 'hip') {
      hipRoofSpecs.push({
        ...roofSpec,
        rotationRadians: building.rotationRadians + Math.PI / 4,
      });
    } else if (building.roofStyle === 'gable') {
      gableRoofSpecs.push(roofSpec);
    } else if (building.roofStyle === 'sawtooth') {
      const teeth = 4;
      for (let tooth = 0; tooth < teeth; tooth += 1) {
        const localEast = -building.width / 2 + building.width * (tooth + 0.5) / teeth;
        const toothCenter = localToDistrict(building, localEast, 0);
        sawtoothRoofSpecs.push({
          ...roofSpec,
          east: toothCenter.east,
          north: toothCenter.north,
          width: building.width / teeth * 1.04,
        });
      }
    } else {
      flatRoofSpecs.push(roofSpec);
    }
  }
  createBoxBatch('building-accents', accentSpecs, accentMaterial, 'cast_receive');
  createBoxBatch('building-flat-roofs', flatRoofSpecs, accentMaterial, 'cast_receive');
  const hipGeometry = new THREE.ConeGeometry(0.71, 1, 4, 1, false);
  hipGeometry.rotateX(Math.PI / 2);
  createGeometryBatch('building-hip-roofs', hipGeometry, hipRoofSpecs, accentMaterial);
  const gableGeometry = new THREE.BufferGeometry();
  gableGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0, -0.5, 0.5,
    0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0, 0.5, 0.5,
    -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5,
    -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5,
    -0.5, -0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5,
    -0.5, -0.5, -0.5, 0, 0.5, 0.5, -0.5, 0.5, -0.5,
    0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0, 0.5, 0.5,
    0.5, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5,
  ], 3));
  gableGeometry.computeVertexNormals();
  createGeometryBatch('building-gable-roofs', gableGeometry, gableRoofSpecs, accentMaterial);
  const sawtoothGeometry = gableGeometry.clone();
  createGeometryBatch('building-sawtooth-roofs', sawtoothGeometry, sawtoothRoofSpecs, accentMaterial);

  const windowDayMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-window-day',
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.24,
    metalness: 0.12,
  }));
  const windowLitMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-window-lit',
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.34,
    emissive: 0xffb65b,
    emissiveIntensity: 0.12,
  }));
  const dayWindows: InstanceSpec[] = [];
  const litWindows: InstanceSpec[] = [];
  outer: for (const building of visibleBuildings) {
    const palette = RUSSIAN_FACADE_PALETTE[
      building.facadePaletteIndex % RUSSIAN_FACADE_PALETTE.length
    ] ?? RUSSIAN_FACADE_PALETTE[0];
    if (!palette) continue;
    const definition = BUILDING_ARCHETYPES[building.archetype];
    const floorHeight = building.height / building.floors;
    const columns = Math.max(2, Math.min(18, Math.round(
      building.width / 10 * definition.windowColumnsPerTenMeters,
    )));
    const rng = createDeterministicRng(`${building.seed}:windows`);
    for (let floor = 0; floor < building.floors; floor += 1) {
      if (building.archetype === 'industrial' && floor > 0) break;
      for (let column = 0; column < columns; column += 1) {
        const localEast = -building.width / 2 + building.width * (column + 0.5) / columns;
        for (const facadeSide of [-1, 1]) {
          const point = localToDistrict(building, localEast, facadeSide * (building.depth / 2 + 0.08));
          const lit = rng() < 0.34;
          const spec: InstanceSpec = {
            east: point.east,
            north: point.north,
            z: floor * floorHeight + floorHeight * 0.46,
            width: Math.min(1.4, building.width / columns * 0.46),
            depth: 0.12,
            height: Math.min(1.55, floorHeight * 0.47),
            rotationRadians: building.rotationRadians,
            color: lit ? palette.windowNight : palette.windowDay,
          };
          (lit ? litWindows : dayWindows).push(spec);
          if (dayWindows.length + litWindows.length >= qualityCaps.maxWindows) break outer;
        }
      }
    }
  }
  createBoxBatch('windows-day', dayWindows, windowDayMaterial);
  createBoxBatch('windows-lit', litWindows, windowLitMaterial);

  const visibleProps = {
    trees: plan.props.filter((item) => item.kind === 'tree').slice(0, qualityCaps.maxTrees),
    benches: plan.props.filter((item) => item.kind === 'bench').slice(0, qualityCaps.maxBenches),
    lamps: plan.props.filter((item) => item.kind === 'street_lamp').slice(0, qualityCaps.maxStreetLamps),
    stops: plan.props.filter((item) => item.kind === 'transit_stop').slice(0, qualityCaps.maxTransitStops),
    bollards: plan.props.filter((item) => item.kind === 'bollard'),
  };

  const trunkMaterial = ownMaterial(new THREE.MeshStandardMaterial({ color: 0x5d4733, roughness: 1 }));
  const trunkGeometry = ownGeometry(new THREE.CylinderGeometry(0.16, 0.23, 1, 6));
  trunkGeometry.rotateX(Math.PI / 2);
  const trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, Math.max(1, visibleProps.trees.length));
  trunkMesh.name = 'tree-trunks';
  trunkMesh.count = visibleProps.trees.length;
  visibleProps.trees.forEach((tree, index) => writeInstance(trunkMesh, index, {
    east: tree.position.east,
    north: tree.position.north,
    z: 0,
    width: tree.scale,
    depth: tree.scale,
    height: 3.5 * tree.scale,
  }));
  trunkMesh.instanceMatrix.needsUpdate = true;
  trunkMesh.castShadow = qualityCaps.dynamicShadows;
  infrastructureLayer.add(trunkMesh);
  meshes.push(trunkMesh);

  const canopyMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-foliage',
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.96,
  }));
  const canopyGeometry = ownGeometry(new THREE.DodecahedronGeometry(1, 0));
  const canopyMesh = new THREE.InstancedMesh(canopyGeometry, canopyMaterial, Math.max(1, visibleProps.trees.length));
  canopyMesh.name = 'tree-canopies';
  canopyMesh.count = visibleProps.trees.length;
  const foliageColors = [0x4c6b43, 0x58774a, 0x667d4c, 0x3f6546];
  visibleProps.trees.forEach((tree, index) => writeInstance(canopyMesh, index, {
    east: tree.position.east,
    north: tree.position.north,
    z: 2.6 * tree.scale,
    width: 3.2 * tree.scale,
    depth: 3.2 * tree.scale,
    height: 3.8 * tree.scale,
    rotationRadians: tree.variant * 0.47,
    color: foliageColors[tree.variant % foliageColors.length] ?? 0x526e45,
  }));
  canopyMesh.instanceMatrix.needsUpdate = true;
  if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;
  canopyMesh.castShadow = qualityCaps.dynamicShadows;
  infrastructureLayer.add(canopyMesh);
  meshes.push(canopyMesh);

  const streetFurnitureMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-street-furniture',
    color: 0x4a4d4b,
    roughness: 0.72,
    metalness: 0.28,
  }));
  const woodMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-bench-wood',
    color: 0x8a6242,
    roughness: 0.82,
  }));
  const benchSeats = visibleProps.benches.map((bench): InstanceSpec => ({
    east: bench.position.east,
    north: bench.position.north,
    z: 0.48 * bench.scale,
    width: 2 * bench.scale,
    depth: 0.52 * bench.scale,
    height: 0.14 * bench.scale,
    rotationRadians: bench.rotationRadians,
  }));
  const benchBacks = visibleProps.benches.map((bench): InstanceSpec => {
    const offset = localToDistrict({
      id: '', center: bench.position, width: 0, depth: 0,
      rotationRadians: bench.rotationRadians, height: 0, floors: 1,
      archetype: 'commercial_pavilion', roofStyle: 'flat', facadePaletteIndex: 0, seed: 0,
    }, 0, 0.27 * bench.scale);
    return {
      east: offset.east,
      north: offset.north,
      z: 0.64 * bench.scale,
      width: 2 * bench.scale,
      depth: 0.12 * bench.scale,
      height: 0.68 * bench.scale,
      rotationRadians: bench.rotationRadians,
    };
  });
  createBoxBatch('bench-seats', benchSeats, woodMaterial, 'cast_receive');
  createBoxBatch('bench-backs', benchBacks, woodMaterial, 'cast_receive');

  const lampPoleGeometry = ownGeometry(new THREE.CylinderGeometry(0.075, 0.11, 1, 7));
  lampPoleGeometry.rotateX(Math.PI / 2);
  const lampPoleMesh = new THREE.InstancedMesh(
    lampPoleGeometry,
    streetFurnitureMaterial,
    Math.max(1, visibleProps.lamps.length),
  );
  lampPoleMesh.name = 'street-lamp-poles';
  lampPoleMesh.count = visibleProps.lamps.length;
  visibleProps.lamps.forEach((lamp, index) => writeInstance(lampPoleMesh, index, {
    east: lamp.position.east,
    north: lamp.position.north,
    z: 0,
    width: lamp.scale,
    depth: lamp.scale,
    height: 6.2 * lamp.scale,
  }));
  lampPoleMesh.instanceMatrix.needsUpdate = true;
  infrastructureLayer.add(lampPoleMesh);
  meshes.push(lampPoleMesh);

  const lampGlowMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-lamp-glow',
    color: 0xffd28a,
    emissive: 0xffa83e,
    emissiveIntensity: 0,
    roughness: 0.24,
  }));
  const lampHeads = visibleProps.lamps.map((lamp): InstanceSpec => ({
    east: lamp.position.east,
    north: lamp.position.north,
    z: 5.95 * lamp.scale,
    width: 0.72 * lamp.scale,
    depth: 0.38 * lamp.scale,
    height: 0.28 * lamp.scale,
    rotationRadians: lamp.rotationRadians,
  }));
  createBoxBatch('street-lamp-heads', lampHeads, lampGlowMaterial);

  const stopPanelMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-transit-stop',
    color: 0x4f8992,
    roughness: 0.38,
    metalness: 0.15,
    transparent: true,
    opacity: 0.88,
  }));
  const stopPanels = visibleProps.stops.flatMap((stop): readonly InstanceSpec[] => [
    {
      east: stop.position.east, north: stop.position.north, z: 0,
      width: 3.6, depth: 0.13, height: 2.45, rotationRadians: stop.rotationRadians,
    },
    {
      east: stop.position.east, north: stop.position.north, z: 2.34,
      width: 4.1, depth: 1.65, height: 0.16, rotationRadians: stop.rotationRadians,
    },
  ]);
  createBoxBatch('transit-stops', stopPanels, stopPanelMaterial, 'cast_receive');

  const visibleVehicles = plan.vehicles.slice(0, qualityCaps.maxVehicles);
  const routes = new Map(plan.routes.map((route) => [route.id, prepareRoute(route)]));
  const vehicleMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-vehicle-bodies', color: 0xffffff, vertexColors: true,
    roughness: 0.48, metalness: 0.18,
  }));
  const vehicleGlassMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-vehicle-glass', color: 0x36505d,
    roughness: 0.2, metalness: 0.32,
  }));
  const headlightMaterial = ownMaterial(new THREE.MeshStandardMaterial({
    name: 'omnitwin-headlights', color: 0xfff2c7, emissive: 0xffd06a,
    emissiveIntensity: 0, roughness: 0.2,
  }));
  const emptyVehicleSpecs = visibleVehicles.map((): InstanceSpec => ({
    east: 0, north: 0, z: 0, width: 1, depth: 1, height: 1,
  }));
  const vehicleBodies = createBoxBatch(
    'moving-vehicle-bodies', emptyVehicleSpecs, vehicleMaterial, 'cast_receive', true,
  );
  const vehicleCabins = createBoxBatch(
    'moving-vehicle-cabins', emptyVehicleSpecs, vehicleGlassMaterial, 'cast_receive', true,
  );
  const vehicleHeadlights = createBoxBatch(
    'moving-vehicle-headlights', emptyVehicleSpecs, headlightMaterial, 'none', true,
  );
  let presentationSeconds = 0;
  let reducedMotion = false;

  const updateVehicleMeshes = () => {
    visibleVehicles.forEach((vehicle: CityVehicle, index) => {
      const route = routes.get(vehicle.routeId);
      if (!route) return;
      const location = sampleRoute(
        route,
        route.totalLength * vehicle.offset01 + presentationSeconds * vehicle.speedMetersPerSecond,
      );
      const isBus = vehicle.kind === 'bus';
      const length = isBus ? 9.6 : 4.25;
      const width = isBus ? 2.45 : 1.82;
      const height = isBus ? 2.9 : 1.3;
      writeInstance(vehicleBodies, index, {
        east: location.east, north: location.north, z: 0.28,
        width: length, depth: width, height,
        rotationRadians: location.heading,
        color: VEHICLE_COLORS[vehicle.colorPaletteIndex % VEHICLE_COLORS.length] ?? 0x65717a,
      });
      const cabinPosition = {
        east: location.east + Math.cos(location.heading) * (isBus ? 0 : 0.35),
        north: location.north + Math.sin(location.heading) * (isBus ? 0 : 0.35),
      };
      writeInstance(vehicleCabins, index, {
        ...cabinPosition,
        z: isBus ? 1.35 : 1.05,
        width: isBus ? 8.7 : 2.35,
        depth: width * 0.86,
        height: isBus ? 1.35 : 0.72,
        rotationRadians: location.heading,
      });
      const nose = {
        east: location.east + Math.cos(location.heading) * (length / 2 + 0.04),
        north: location.north + Math.sin(location.heading) * (length / 2 + 0.04),
      };
      writeInstance(vehicleHeadlights, index, {
        ...nose,
        z: 0.62,
        width: 0.08,
        depth: width * 0.72,
        height: 0.18,
        rotationRadians: location.heading,
      });
    });
    for (const mesh of [vehicleBodies, vehicleCabins, vehicleHeadlights]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  };
  updateVehicleMeshes();

  const updateEnvironment = (state: EnvironmentSceneState) => {
    windowLitMaterial.emissiveIntensity = state.sun.windowEmission * 1.45;
    lampGlowMaterial.emissiveIntensity = state.sun.streetLightIntensity * 3.2;
    headlightMaterial.emissiveIntensity = state.sun.streetLightIntensity * 2.7;
    roadMaterial.roughness = Math.max(0.28, 0.9 - state.weather.wetness * 0.52);
    roadMaterial.metalness = 0.02 + state.weather.wetness * 0.18;
    groundMaterial.color.set(state.weather.snowCover > 0.2 ? 0xc9ceca : 0x74806a);
    sidewalkMaterial.color.set(state.weather.snowCover > 0.35 ? 0xd7d9d5 : 0xa7a294);
  };

  const frame = (deltaMilliseconds: number) => {
    void deltaMilliseconds;
  };

  const dispose = () => {
    group.clear();
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    geometries.clear();
    materials.clear();
    meshes.length = 0;
  };

  return {
    group,
    stats: {
      buildings: visibleBuildings.length,
      trees: visibleProps.trees.length,
      props: visibleProps.benches.length + visibleProps.lamps.length + visibleProps.stops.length
        + visibleProps.bollards.length,
      vehicles: visibleVehicles.length,
      drawGroups: meshes.length,
    },
    updateEnvironment,
    setPresentationTime(presentationTimeMs) {
      presentationSeconds = ((presentationTimeMs / 1_000) % 86_400 + 86_400) % 86_400;
      updateVehicleMeshes();
    },
    setReducedMotion(next) {
      reducedMotion = next;
      if (next) updateVehicleMeshes();
    },
    setLayerVisibility(visibility) {
      buildingLayer.visible = visibility.buildings;
      infrastructureLayer.visible = visibility.infrastructure;
    },
    frame,
    dispose,
  };
}
