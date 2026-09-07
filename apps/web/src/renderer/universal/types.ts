export type GeoPosition = readonly [longitude: number, latitude: number];

export type UniversalQualityTier = 'high' | 'mid' | 'low';

export type UniversalSemanticLod =
  | 'territory'
  | 'footprints'
  | 'extrusions'
  | 'detail';

export interface UniversalSourceIdentity {
  /** Stable provider/source name, for example overture-buildings or openmaptiles. */
  readonly sourceId: string;
  /** Immutable upstream dataset/release version. */
  readonly datasetVersion: string;
  /** Stable source feature identity. It must never be synthesized from screen coordinates. */
  readonly sourceFeatureId: string | number;
  /** Optional tile identity used to disambiguate clipped area features. */
  readonly sourceTileKey?: string;
}

export interface VisualSynthesisDisclosure {
  readonly provenance: 'visual_synthesis';
  readonly temporalMapping: 'visual_synthesis';
  readonly scientificClaim: false;
  readonly displayLabel: string;
}

export function sourceIdentityKey(identity: UniversalSourceIdentity): string {
  const sourceId = identity.sourceId.trim();
  const datasetVersion = identity.datasetVersion.trim();
  const featureId = String(identity.sourceFeatureId).trim();
  const tileKey = identity.sourceTileKey?.trim() ?? '';
  if (
    !sourceId
    || !datasetVersion
    || !featureId
    || (typeof identity.sourceFeatureId === 'number'
      && !Number.isFinite(identity.sourceFeatureId))
  ) {
    throw new RangeError('Source identity requires sourceId, datasetVersion, and sourceFeatureId');
  }
  return `${sourceId}\u0000${datasetVersion}\u0000${typeof identity.sourceFeatureId}:${featureId}\u0000${tileKey}`;
}

export function isGeoPosition(value: GeoPosition): boolean {
  return Number.isFinite(value[0])
    && Number.isFinite(value[1])
    && value[0] >= -180
    && value[0] <= 180
    && value[1] >= -90
    && value[1] <= 90;
}
