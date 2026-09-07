/**
 * Secondary MapLibre sprite used by the universal renderer. The paired sprite
 * JSON is the authoritative image mapping; its descriptor carries release
 * hashes and rights without coupling the style to an asset build timestamp.
 */
import { rendererAssetUrl } from './assetUrl';

export const UNIVERSAL_MATERIAL_ATLAS_VERSION = '1.0.0' as const;

export const UNIVERSAL_MATERIAL_ATLAS_ID = 'omnitwin-lowpoly-atlas-v1' as const;

export const UNIVERSAL_MATERIAL_SPRITE_ID = 'omnitwin' as const;

export const UNIVERSAL_MATERIAL_IMAGE_KEYS = [
  'ground-grass-day',
  'ground-soil-day',
  'ground-residential-day',
  'ground-forest-day',
  'road-asphalt-day',
  'water-gloss-0-day',
  'water-gloss-0-dusk',
  'water-gloss-0-night',
  'water-gloss-1-day',
  'water-gloss-1-dusk',
  'water-gloss-1-night',
  'water-gloss-2-day',
  'water-gloss-2-dusk',
  'water-gloss-2-night',
  'water-gloss-3-day',
  'water-gloss-3-dusk',
  'water-gloss-3-night',
  'water-gloss-0-rain',
  'water-gloss-1-rain',
  'water-gloss-2-rain',
  'water-gloss-3-rain',
  'facade-sandstone',
  'facade-brick',
  'facade-concrete',
  'facade-slate',
  'facade-ochre',
  'facade-plaster',
  'facade-industrial',
  'facade-civic',
  'roof-tile',
  'roof-metal',
  'roof-bitumen',
  'roof-concrete',
  'roof-green',
  'tree-decid-0',
  'tree-decid-1',
  'tree-decid-2',
  'tree-decid-3',
  'tree-decid-4',
  'tree-decid-5',
  'tree-decid-6',
  'tree-decid-7',
  'tree-conifer-0',
  'tree-conifer-1',
  'tree-conifer-2',
  'tree-conifer-3',
  'tree-shrub-0',
  'tree-shrub-1',
  'tree-shrub-2',
  'tree-shrub-3',
] as const;

export type UniversalMaterialImageKey = typeof UNIVERSAL_MATERIAL_IMAGE_KEYS[number];

export interface UniversalMaterialSpriteMappingV1 {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

export interface UniversalMaterialIconMappingV1 {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly mask: false;
}

/** Payload served by the versioned .descriptor.json companion asset. */
export interface UniversalMaterialAtlasV1 {
  readonly kind: 'UniversalMaterialAtlasV1';
  readonly version: typeof UNIVERSAL_MATERIAL_ATLAS_VERSION;
  readonly url: string;
  readonly spriteUrl: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly width: 512;
  readonly height: 512;
  readonly pixelRatio: 1;
  readonly mapping: Readonly<Record<string, UniversalMaterialSpriteMappingV1>>;
  readonly iconMapping: Readonly<Record<string, UniversalMaterialIconMappingV1>>;
  readonly variants: Readonly<Record<'1x' | '2x', Readonly<Record<string, unknown>>>>;
  readonly provenance: {
    readonly representation: 'visual_synthesis';
    readonly generator: string;
    readonly referenceRole: 'style_only';
  };
  readonly rights: {
    readonly statement: string;
    readonly attributionRequired: false;
  };
  readonly attribution: string;
}

export interface UniversalMaterialAtlasStyleReferenceV1 {
  readonly contractVersion: 1;
  readonly assetId: typeof UNIVERSAL_MATERIAL_ATLAS_ID;
  readonly version: typeof UNIVERSAL_MATERIAL_ATLAS_VERSION;
  readonly spriteId: typeof UNIVERSAL_MATERIAL_SPRITE_ID;
  readonly spriteUrl: string;
  readonly descriptorUrl: string;
  readonly width: 512;
  readonly height: 512;
  readonly attribution: 'OmniTwin visual synthesis';
  readonly scientificClaim: false;
}

export const OMNITWIN_MATERIAL_ATLAS: UniversalMaterialAtlasStyleReferenceV1 = Object.freeze({
  contractVersion: 1,
  assetId: UNIVERSAL_MATERIAL_ATLAS_ID,
  version: UNIVERSAL_MATERIAL_ATLAS_VERSION,
  spriteId: UNIVERSAL_MATERIAL_SPRITE_ID,
  spriteUrl: rendererAssetUrl(`/assets/universal-materials/${UNIVERSAL_MATERIAL_ATLAS_ID}`),
  descriptorUrl: rendererAssetUrl(`/assets/universal-materials/${UNIVERSAL_MATERIAL_ATLAS_ID}.descriptor.json`),
  width: 512,
  height: 512,
  attribution: 'OmniTwin visual synthesis',
  scientificClaim: false,
});

export const UNIVERSAL_MATERIAL_ATLAS_PNG_URL =
  rendererAssetUrl(`/assets/universal-materials/${UNIVERSAL_MATERIAL_ATLAS_ID}.png`);

const VEGETATION_ICON_LAYOUT = [
  ...Array.from({ length: 8 }, (_, index) => ({
    key: `tree-decid-${index}`,
    x: 4 + index * 56,
    y: 140,
  })),
  ...Array.from({ length: 4 }, (_, index) => ({
    key: `tree-conifer-${index}`,
    x: 4 + index * 56,
    y: 212,
  })),
  ...Array.from({ length: 4 }, (_, index) => ({
    key: `tree-shrub-${index}`,
    x: 228 + index * 56,
    y: 212,
  })),
] as const;

/**
 * Deck's IconLayer consumes the same pixels as MapLibre's secondary sprite.
 * Keeping this tiny mapping in code avoids a second network fetch and makes
 * provider failover independent from decoration metadata loading.
 */
export const UNIVERSAL_VEGETATION_ICON_MAPPING: Readonly<
  Record<string, UniversalMaterialIconMappingV1>
> = Object.freeze(Object.fromEntries(VEGETATION_ICON_LAYOUT.map(({ key, x, y }) => [
  key,
  Object.freeze({
    x,
    y,
    width: 48,
    height: 64,
    anchorX: 24,
    anchorY: 64,
    mask: false as const,
  }),
])));

export function universalMaterialImageId(key: UniversalMaterialImageKey): string {
  return `${UNIVERSAL_MATERIAL_SPRITE_ID}:${key}`;
}
