import { createDeterministicRng, deterministicBetween } from '../rng';
import { createBuildingGrammar } from './archetypes';
import type {
  CityBuilding,
  CityCrosswalk,
  CityDistrictPlan,
  CityRoad,
  CityRoute,
  CitySceneBoundsMeters,
  CitySidewalk,
  CityVehicle,
  PointMeters,
  RoadOrientation,
  RussianBuildingArchetype,
  StreetProp,
  StreetPropKind,
} from './types';

export interface RussianDistrictPlanOptions {
  readonly id?: string;
  readonly seed: string;
  readonly bounds?: CitySceneBoundsMeters;
  /** Required acknowledgement that the layout is presentation-only. */
  readonly layoutMode: 'synthetic_visual';
  readonly vehicleCount?: number;
}

const ARCHETYPE_SEQUENCE: readonly RussianBuildingArchetype[] = [
  'stalinist',
  'panel_5',
  'brick_midrise',
  'panel_9',
  'civic',
  'tower_16',
  'commercial_pavilion',
  'industrial',
  'private_house',
] as const;

function road(
  id: string,
  orientation: RoadOrientation,
  offset: number,
  length: number,
  width: number,
  laneCount: number,
): CityRoad {
  return {
    id,
    orientation,
    center: orientation === 'east_west'
      ? { east: 0, north: offset }
      : { east: offset, north: 0 },
    length,
    width,
    laneCount,
  };
}

function sidewalkPair(item: CityRoad, sidewalkWidth: number): readonly CitySidewalk[] {
  const offset = item.width / 2 + sidewalkWidth / 2 + 0.6;
  if (item.orientation === 'east_west') {
    return [-1, 1].map((side) => ({
      id: `${item.id}:sidewalk:${side}`,
      center: { east: item.center.east, north: item.center.north + side * offset },
      orientation: item.orientation,
      length: item.length,
      width: sidewalkWidth,
    }));
  }
  return [-1, 1].map((side) => ({
    id: `${item.id}:sidewalk:${side}`,
    center: { east: item.center.east + side * offset, north: item.center.north },
    orientation: item.orientation,
    length: item.length,
    width: sidewalkWidth,
  }));
}

interface OpenInterval {
  readonly minimum: number;
  readonly maximum: number;
}

function blockIntervals(
  extent: number,
  centers: readonly number[],
  widths: readonly number[],
  margin = 8,
): readonly OpenInterval[] {
  const edges: number[] = [-extent / 2];
  centers.forEach((center, index) => {
    edges.push(center - (widths[index] ?? 0) / 2 - margin);
    edges.push(center + (widths[index] ?? 0) / 2 + margin);
  });
  edges.push(extent / 2);
  const intervals: OpenInterval[] = [];
  for (let index = 0; index < edges.length - 1; index += 2) {
    const minimum = edges[index];
    const maximum = edges[index + 1];
    if (minimum !== undefined && maximum !== undefined && maximum - minimum >= 12) {
      intervals.push({ minimum, maximum });
    }
  }
  return intervals;
}

function createBuildings(
  seed: string,
  bounds: CitySceneBoundsMeters,
  verticalCenters: readonly number[],
  verticalWidths: readonly number[],
  horizontalCenters: readonly number[],
  horizontalWidths: readonly number[],
): readonly CityBuilding[] {
  const xBlocks = blockIntervals(bounds.width, verticalCenters, verticalWidths);
  const yBlocks = blockIntervals(bounds.height, horizontalCenters, horizontalWidths);
  const buildings: CityBuilding[] = [];
  let blockIndex = 0;

  for (const xBlock of xBlocks) {
    for (const yBlock of yBlocks) {
      const rng = createDeterministicRng(`${seed}:block:${blockIndex}`);
      const blockWidth = xBlock.maximum - xBlock.minimum;
      const blockDepth = yBlock.maximum - yBlock.minimum;
      const splitCount = Math.min(2, blockWidth > 88 && blockDepth > 38 && rng() > 0.34 ? 2 : 1);
      for (let split = 0; split < splitCount; split += 1) {
        const availableWidth = splitCount === 2 ? blockWidth / 2 - 8 : blockWidth - 10;
        const availableDepth = blockDepth - 10;
        const sequenceIndex = (blockIndex + split * 3) % ARCHETYPE_SEQUENCE.length;
        const archetype = ARCHETYPE_SEQUENCE[sequenceIndex] ?? 'panel_5';
        const grammar = createBuildingGrammar(
          `${seed}:block:${blockIndex}:building:${split}`,
          archetype,
          availableWidth,
          availableDepth,
        );
        const splitWidth = blockWidth / splitCount;
        const slotCenter = xBlock.minimum + splitWidth * (split + 0.5);
        const jitterEast = deterministicBetween(rng, -2.4, 2.4);
        const jitterNorth = deterministicBetween(rng, -2.1, 2.1);
        const rotate = availableDepth > availableWidth * 1.25;
        buildings.push({
          id: `building-${blockIndex}-${split}`,
          center: {
            east: slotCenter + jitterEast,
            north: (yBlock.minimum + yBlock.maximum) / 2 + jitterNorth,
          },
          width: rotate ? grammar.depth : grammar.width,
          depth: rotate ? grammar.width : grammar.depth,
          rotationRadians: rotate ? Math.PI / 2 : 0,
          height: grammar.height,
          floors: grammar.floors,
          archetype: grammar.archetype,
          roofStyle: grammar.roofStyle,
          facadePaletteIndex: grammar.facadePaletteIndex,
          seed: grammar.seed,
        });
      }
      blockIndex += 1;
    }
  }
  return buildings;
}

function pointAlong(item: CityRoad, along: number, side: number): PointMeters {
  const offset = item.width / 2 + 4.5;
  return item.orientation === 'east_west'
    ? { east: along, north: item.center.north + side * offset }
    : { east: item.center.east + side * offset, north: along };
}

function createStreetProps(seed: string, roads: readonly CityRoad[]): readonly StreetProp[] {
  const props: StreetProp[] = [];
  const add = (
    kind: StreetPropKind,
    roadItem: CityRoad,
    along: number,
    side: number,
    variant: number,
    scale = 1,
  ) => {
    props.push({
      id: `${roadItem.id}:${kind}:${props.length}`,
      kind,
      position: pointAlong(roadItem, along, side),
      rotationRadians: roadItem.orientation === 'east_west' ? 0 : Math.PI / 2,
      scale,
      variant,
    });
  };

  roads.forEach((roadItem, roadIndex) => {
    const rng = createDeterministicRng(`${seed}:props:${roadItem.id}`);
    const half = roadItem.length / 2 - 18;
    const spacing = roadIndex % 3 === 1 ? 34 : 42;
    let slot = 0;
    for (let along = -half; along <= half; along += spacing) {
      for (const side of [-1, 1]) {
        const jitter = deterministicBetween(rng, -2.2, 2.2);
        add('tree', roadItem, along + jitter, side, Math.floor(rng() * 4), 0.82 + rng() * 0.38);
        if (slot % 2 === 0) add('street_lamp', roadItem, along + spacing * 0.42, side, roadIndex % 3);
        if (slot % 4 === 1) add('bench', roadItem, along + spacing * 0.2, side, Math.floor(rng() * 3), 0.9 + rng() * 0.15);
      }
      slot += 1;
    }
    if (roadIndex < 2) {
      add('transit_stop', roadItem, roadItem.length * 0.18, 1, roadIndex);
      add('transit_stop', roadItem, -roadItem.length * 0.18, -1, roadIndex + 1);
    }
  });
  return props;
}

function createCrosswalks(
  verticalCenters: readonly number[],
  horizontalCenters: readonly number[],
): readonly CityCrosswalk[] {
  const crosswalks: CityCrosswalk[] = [];
  for (const east of verticalCenters) {
    for (const north of horizontalCenters) {
      crosswalks.push({
        id: `crosswalk-ew-${east}-${north}`,
        center: { east, north: north + 8 },
        orientation: 'east_west',
        length: 13,
        width: 4.2,
        stripeCount: 7,
      });
      crosswalks.push({
        id: `crosswalk-ns-${east}-${north}`,
        center: { east: east + 8, north },
        orientation: 'north_south',
        length: 13,
        width: 4.2,
        stripeCount: 7,
      });
    }
  }
  return crosswalks;
}

function createRoutes(
  bounds: CitySceneBoundsMeters,
  verticalCenters: readonly number[],
  horizontalCenters: readonly number[],
): readonly CityRoute[] {
  const insetX = Math.min(bounds.width * 0.28, Math.abs(verticalCenters[0] ?? 120));
  const insetY = Math.min(bounds.height * 0.3, Math.abs(horizontalCenters[0] ?? 100));
  const laneOffset = 3.2;
  return [
    {
      id: 'route-inner-clockwise',
      closed: true,
      points: [
        { east: -insetX + laneOffset, north: -insetY + laneOffset },
        { east: insetX - laneOffset, north: -insetY + laneOffset },
        { east: insetX - laneOffset, north: insetY - laneOffset },
        { east: -insetX + laneOffset, north: insetY - laneOffset },
      ],
    },
    {
      id: 'route-outer-counterclockwise',
      closed: true,
      points: [
        { east: -insetX - laneOffset, north: -insetY - laneOffset },
        { east: -insetX - laneOffset, north: insetY + laneOffset },
        { east: insetX + laneOffset, north: insetY + laneOffset },
        { east: insetX + laneOffset, north: -insetY - laneOffset },
      ],
    },
    {
      id: 'route-central',
      closed: true,
      points: [
        { east: -bounds.width * 0.42, north: -laneOffset },
        { east: bounds.width * 0.42, north: -laneOffset },
        { east: bounds.width * 0.42, north: laneOffset },
        { east: -bounds.width * 0.42, north: laneOffset },
      ],
    },
  ];
}

function createVehicles(seed: string, routes: readonly CityRoute[], count: number): readonly CityVehicle[] {
  const vehicles: CityVehicle[] = [];
  for (let index = 0; index < count; index += 1) {
    const rng = createDeterministicRng(`${seed}:vehicle:${index}`);
    const route = routes[index % routes.length];
    if (!route) continue;
    const kind = index % 11 === 0 ? 'bus' : 'car';
    vehicles.push({
      id: `vehicle-${index}`,
      routeId: route.id,
      offset01: (index / Math.max(1, count) + rng() * 0.08) % 1,
      speedMetersPerSecond: kind === 'bus'
        ? deterministicBetween(rng, 5.2, 8.5)
        : deterministicBetween(rng, 7.5, 13.5),
      colorPaletteIndex: Math.floor(rng() * 8),
      kind,
    });
  }
  return vehicles;
}

export function createRussianDistrictPlan(options: RussianDistrictPlanOptions): CityDistrictPlan {
  const bounds = options.bounds ?? { width: 520, height: 440 };
  if (bounds.width < 240 || bounds.height < 220) {
    throw new RangeError('Synthetic district bounds must be at least 240 × 220 meters');
  }
  const verticalCenters = [-bounds.width * 0.29, 0, bounds.width * 0.29];
  const horizontalCenters = [-bounds.height * 0.3, 0, bounds.height * 0.3];
  const verticalWidths = [12, 20, 12];
  const horizontalWidths = [11, 18, 11];
  const roads = [
    ...verticalCenters.map((center, index) => road(
      `road-v-${index}`,
      'north_south',
      center,
      bounds.height,
      verticalWidths[index] ?? 12,
      index === 1 ? 4 : 2,
    )),
    ...horizontalCenters.map((center, index) => road(
      `road-h-${index}`,
      'east_west',
      center,
      bounds.width,
      horizontalWidths[index] ?? 11,
      index === 1 ? 4 : 2,
    )),
  ];
  const sidewalks = roads.flatMap((item) => sidewalkPair(item, item.laneCount > 2 ? 5.2 : 3.8));
  const routes = createRoutes(bounds, verticalCenters, horizontalCenters);

  return {
    id: options.id ?? `synthetic-russian-district:${options.seed}`,
    seed: options.seed,
    bounds,
    visualProvenance: options.layoutMode,
    fieldProvenance: {
      geometry: options.layoutMode,
      buildingAppearance: 'visual_synthesis',
      streetFurniture: 'visual_synthesis',
      movement: 'visual_synthesis',
    },
    scientificClaim: false,
    buildings: createBuildings(
      options.seed,
      bounds,
      verticalCenters,
      verticalWidths,
      horizontalCenters,
      horizontalWidths,
    ),
    roads,
    sidewalks,
    crosswalks: createCrosswalks(verticalCenters, horizontalCenters),
    props: createStreetProps(options.seed, roads),
    routes,
    vehicles: createVehicles(options.seed, routes, Math.max(0, options.vehicleCount ?? 48)),
  };
}
