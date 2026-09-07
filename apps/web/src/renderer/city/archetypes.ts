import { createDeterministicRng, deterministicBetween, hashSeed } from '../rng';
import type {
  BuildingRoofStyle,
  RussianBuildingArchetype,
} from './types';

export interface BuildingArchetypeDefinition {
  readonly id: RussianBuildingArchetype;
  readonly floorRange: readonly [minimum: number, maximum: number];
  readonly floorHeightMeters: number;
  readonly widthRangeMeters: readonly [minimum: number, maximum: number];
  readonly depthRangeMeters: readonly [minimum: number, maximum: number];
  readonly roofStyles: readonly BuildingRoofStyle[];
  readonly windowColumnsPerTenMeters: number;
  readonly setbackRatio: number;
}

export interface BuildingGrammarResult {
  readonly archetype: RussianBuildingArchetype;
  readonly floors: number;
  readonly height: number;
  readonly width: number;
  readonly depth: number;
  readonly roofStyle: BuildingRoofStyle;
  readonly facadePaletteIndex: number;
  readonly seed: number;
}

export interface FacadePaletteEntry {
  readonly facade: number;
  readonly secondary: number;
  readonly roof: number;
  readonly windowDay: number;
  readonly windowNight: number;
}

export const RUSSIAN_FACADE_PALETTE: readonly FacadePaletteEntry[] = [
  { facade: 0xc9c2ae, secondary: 0xede5d4, roof: 0x555c62, windowDay: 0x7795a1, windowNight: 0xffc66d },
  { facade: 0xb66e51, secondary: 0xd9a989, roof: 0x493f3b, windowDay: 0x668894, windowNight: 0xffb95e },
  { facade: 0xb7bdaf, secondary: 0xd8d6c9, roof: 0x505a58, windowDay: 0x718d9b, windowNight: 0xffd48a },
  { facade: 0xd3b88f, secondary: 0xf2dfbc, roof: 0x67463f, windowDay: 0x66818c, windowNight: 0xffbf63 },
  { facade: 0x9ca7ad, secondary: 0xc9d0cf, roof: 0x454b50, windowDay: 0x5f7c8e, windowNight: 0xffca72 },
  { facade: 0xb7a59b, secondary: 0xe2d5c8, roof: 0x594d48, windowDay: 0x6b8790, windowNight: 0xffd083 },
  { facade: 0x9e755c, secondary: 0xc9a183, roof: 0x493b38, windowDay: 0x617e8c, windowNight: 0xffb557 },
  { facade: 0xc8c9c4, secondary: 0xf0eee4, roof: 0x5d6063, windowDay: 0x738f99, windowNight: 0xffd596 },
] as const;

export const BUILDING_ARCHETYPES: Readonly<Record<
  RussianBuildingArchetype,
  BuildingArchetypeDefinition
>> = {
  panel_5: {
    id: 'panel_5', floorRange: [5, 5], floorHeightMeters: 2.85,
    widthRangeMeters: [34, 72], depthRangeMeters: [10, 14],
    roofStyles: ['flat', 'parapet'], windowColumnsPerTenMeters: 3.2, setbackRatio: 0.08,
  },
  panel_9: {
    id: 'panel_9', floorRange: [8, 10], floorHeightMeters: 2.9,
    widthRangeMeters: [30, 66], depthRangeMeters: [11, 16],
    roofStyles: ['flat', 'parapet'], windowColumnsPerTenMeters: 3, setbackRatio: 0.1,
  },
  brick_midrise: {
    id: 'brick_midrise', floorRange: [5, 8], floorHeightMeters: 3,
    widthRangeMeters: [22, 50], depthRangeMeters: [12, 20],
    roofStyles: ['hip', 'gable', 'parapet'], windowColumnsPerTenMeters: 2.7, setbackRatio: 0.11,
  },
  stalinist: {
    id: 'stalinist', floorRange: [4, 7], floorHeightMeters: 3.45,
    widthRangeMeters: [28, 58], depthRangeMeters: [14, 22],
    roofStyles: ['hip', 'parapet'], windowColumnsPerTenMeters: 2.5, setbackRatio: 0.06,
  },
  tower_16: {
    id: 'tower_16', floorRange: [14, 18], floorHeightMeters: 2.9,
    widthRangeMeters: [18, 28], depthRangeMeters: [18, 28],
    roofStyles: ['flat', 'parapet'], windowColumnsPerTenMeters: 3, setbackRatio: 0.16,
  },
  industrial: {
    id: 'industrial', floorRange: [1, 3], floorHeightMeters: 4.6,
    widthRangeMeters: [32, 80], depthRangeMeters: [22, 52],
    roofStyles: ['sawtooth', 'gable', 'flat'], windowColumnsPerTenMeters: 1.4, setbackRatio: 0.14,
  },
  civic: {
    id: 'civic', floorRange: [2, 5], floorHeightMeters: 3.8,
    widthRangeMeters: [24, 58], depthRangeMeters: [18, 34],
    roofStyles: ['parapet', 'hip', 'flat'], windowColumnsPerTenMeters: 2.2, setbackRatio: 0.18,
  },
  private_house: {
    id: 'private_house', floorRange: [1, 2], floorHeightMeters: 3,
    widthRangeMeters: [8, 15], depthRangeMeters: [7, 13],
    roofStyles: ['gable', 'hip'], windowColumnsPerTenMeters: 1.8, setbackRatio: 0.22,
  },
  commercial_pavilion: {
    id: 'commercial_pavilion', floorRange: [1, 2], floorHeightMeters: 3.7,
    widthRangeMeters: [12, 30], depthRangeMeters: [8, 22],
    roofStyles: ['flat', 'parapet'], windowColumnsPerTenMeters: 3.6, setbackRatio: 0.07,
  },
} as const;

function integerBetween(rng: () => number, minimum: number, maximum: number): number {
  return Math.floor(deterministicBetween(rng, minimum, maximum + 1));
}

export function createBuildingGrammar(
  seed: number | string,
  archetype: RussianBuildingArchetype,
  availableWidth: number,
  availableDepth: number,
): BuildingGrammarResult {
  const definition = BUILDING_ARCHETYPES[archetype];
  const rng = createDeterministicRng(`${seed}:${archetype}`);
  const width = Math.min(
    availableWidth,
    deterministicBetween(rng, definition.widthRangeMeters[0], definition.widthRangeMeters[1]),
  );
  const depth = Math.min(
    availableDepth,
    deterministicBetween(rng, definition.depthRangeMeters[0], definition.depthRangeMeters[1]),
  );
  const floors = integerBetween(rng, definition.floorRange[0], definition.floorRange[1]);
  const roofStyle = definition.roofStyles[
    Math.floor(rng() * definition.roofStyles.length) % definition.roofStyles.length
  ] ?? 'flat';
  const stableSeed = hashSeed(`${seed}:${archetype}:building`);

  return {
    archetype,
    floors,
    height: floors * definition.floorHeightMeters,
    width: Math.max(5, width),
    depth: Math.max(5, depth),
    roofStyle,
    facadePaletteIndex: Math.floor(rng() * RUSSIAN_FACADE_PALETTE.length),
    seed: stableSeed,
  };
}
