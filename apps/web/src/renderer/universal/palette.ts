import { hashSeed } from '../rng';
import { sourceIdentityKey, type UniversalSourceIdentity } from './types';

export const UNIVERSAL_LOW_POLY_PALETTE = {
  facade: [
    '#d7c3a7',
    '#caa27b',
    '#b9c4c7',
    '#c7b98d',
    '#c8a6a2',
    '#aeb9aa',
    '#b5afaa',
    '#d4b78f',
  ],
  roof: [
    '#625c58',
    '#76584f',
    '#59646a',
    '#6f6857',
    '#765f67',
    '#4f635a',
  ],
  facadePatterns: [
    'stucco_noise',
    'brick_grid',
    'panel_grid',
    'window_grid',
    'timber_bands',
    'glass_grid',
  ],
} as const;

export const UNIVERSAL_COLOR_ROLES = {
  neutralContext: '#7f9098',
  primaryFocal: '#35d7df',
  comparison: '#ffb64d',
  selected: '#ffffff',
  alert: '#ff667a',
} as const;

export type UniversalFacadePattern =
  typeof UNIVERSAL_LOW_POLY_PALETTE.facadePatterns[number];

export type BuildingAppearanceQuality = 'source_exact' | 'source_mapped' | 'style_derived';

export interface SourceBackedBuildingAppearanceInput extends UniversalSourceIdentity {
  /** Compile-time/runtime guard: this renderer never creates a footprint. */
  readonly footprintOrigin: 'source_geometry';
  readonly buildingClass?: string | null;
  readonly facadeColor?: string | null;
  readonly facadeMaterial?: string | null;
  readonly roofColor?: string | null;
  readonly roofMaterial?: string | null;
}

export interface LowPolyBuildingAppearance {
  readonly stableKey: string;
  readonly footprintOrigin: 'source_geometry';
  readonly facadeColor: string;
  readonly facadeColorQuality: Extract<BuildingAppearanceQuality, 'source_exact' | 'style_derived'>;
  readonly facadePaletteIndex: number | null;
  readonly roofColor: string;
  readonly roofColorQuality: Extract<BuildingAppearanceQuality, 'source_exact' | 'style_derived'>;
  readonly roofPaletteIndex: number | null;
  readonly facadePattern: UniversalFacadePattern;
  readonly facadePatternQuality: Extract<BuildingAppearanceQuality, 'source_mapped' | 'style_derived'>;
  readonly sourceFacadeMaterial: string | null;
  readonly sourceRoofMaterial: string | null;
  readonly provenance: 'appearance_styling';
  readonly scientificClaim: false;
}

const SOURCE_COLOR_NAMES: Readonly<Record<string, string>> = {
  beige: '#d8c8a8',
  black: '#1b1d1f',
  blue: '#5683a6',
  brown: '#7b5b45',
  cream: '#eadbbd',
  gray: '#8d9498',
  green: '#66836c',
  grey: '#8d9498',
  orange: '#c9824f',
  red: '#a9655f',
  silver: '#aeb5b9',
  white: '#ece8df',
  yellow: '#d5bb65',
};

const MATERIAL_PATTERNS: Readonly<Record<string, UniversalFacadePattern>> = {
  brick: 'brick_grid',
  bricks: 'brick_grid',
  concrete: 'panel_grid',
  glass: 'glass_grid',
  metal: 'panel_grid',
  panels: 'panel_grid',
  plaster: 'stucco_noise',
  stone: 'brick_grid',
  stucco: 'stucco_noise',
  timber: 'timber_bands',
  wood: 'timber_bands',
};

function normalizedText(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized || null;
}

export function normalizeSourceColor(value: string | null | undefined): string | null {
  const normalized = normalizedText(value);
  if (!normalized) return null;
  const named = SOURCE_COLOR_NAMES[normalized];
  if (named) return named;
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized.toLowerCase();
  const shortHex = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(normalized);
  if (shortHex) {
    return `#${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}`
      .toLowerCase();
  }
  return null;
}

/**
 * Resolves appearance only for a source-backed building footprint. Missing
 * facade metadata changes styling, never geometry or source provenance.
 */
export function resolveLowPolyBuildingAppearance(
  input: SourceBackedBuildingAppearanceInput,
): LowPolyBuildingAppearance {
  if (input.footprintOrigin !== 'source_geometry') {
    throw new RangeError('Low-poly building appearance requires a source-backed footprint');
  }
  const stableKey = sourceIdentityKey(input);
  const classKey = normalizedText(input.buildingClass) ?? 'building';
  const appearanceSeed = hashSeed(`${stableKey}\u0000${classKey}`);
  const facadePaletteIndex = appearanceSeed % UNIVERSAL_LOW_POLY_PALETTE.facade.length;
  const roofPaletteIndex = hashSeed(`${stableKey}\u0000roof`)
    % UNIVERSAL_LOW_POLY_PALETTE.roof.length;
  const sourceFacadeColor = normalizeSourceColor(input.facadeColor);
  const sourceRoofColor = normalizeSourceColor(input.roofColor);
  const sourceFacadeMaterial = normalizedText(input.facadeMaterial);
  const sourceRoofMaterial = normalizedText(input.roofMaterial);
  const mappedPattern = sourceFacadeMaterial
    ? MATERIAL_PATTERNS[sourceFacadeMaterial]
    : undefined;
  const fallbackPattern = UNIVERSAL_LOW_POLY_PALETTE.facadePatterns[
    hashSeed(`${stableKey}\u0000pattern`) % UNIVERSAL_LOW_POLY_PALETTE.facadePatterns.length
  ];

  return {
    stableKey,
    footprintOrigin: 'source_geometry',
    facadeColor: sourceFacadeColor
      ?? UNIVERSAL_LOW_POLY_PALETTE.facade[facadePaletteIndex],
    facadeColorQuality: sourceFacadeColor ? 'source_exact' : 'style_derived',
    facadePaletteIndex: sourceFacadeColor ? null : facadePaletteIndex,
    roofColor: sourceRoofColor
      ?? UNIVERSAL_LOW_POLY_PALETTE.roof[roofPaletteIndex],
    roofColorQuality: sourceRoofColor ? 'source_exact' : 'style_derived',
    roofPaletteIndex: sourceRoofColor ? null : roofPaletteIndex,
    facadePattern: mappedPattern ?? fallbackPattern,
    facadePatternQuality: mappedPattern ? 'source_mapped' : 'style_derived',
    sourceFacadeMaterial,
    sourceRoofMaterial,
    provenance: 'appearance_styling',
    scientificClaim: false,
  };
}
