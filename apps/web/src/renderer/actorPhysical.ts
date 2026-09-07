import type { UniversalActorKind } from './actorAtlas';

/** Explicit visual defaults, never observed resident or vehicle measurements. */
export const ADULT_INK_HEIGHT_METERS = 1.8;
export const VEHICLE_INK_LENGTH_METERS = 4.5;
export const VEHICLE_GROUND_CLEARANCE_METERS = 0.1;
/** The radial alpha cutoff leaves ~5 CSS px of visible core inside this 8 px quad. */
export const PERSON_IMPOSTOR_DIAMETER_CSS_PIXELS = 8;
export const PERSON_IMPOSTOR_ALPHA_FALLOFF = 4.5;
export const ACTOR_ALPHA_CUTOFF = 0.16;

/** CPU QA mirror of the shader's perspective-measured CSS-pixel LOD transition. */
export function personImpostorMix(physicalHeightPixels: number): number {
  if (!Number.isFinite(physicalHeightPixels) || physicalHeightPixels < 0) throw new RangeError('Projected actor height must be finite and non-negative');
  const t = Math.max(0, Math.min(1, (physicalHeightPixels - 3) / 2));
  return 1 - t * t * (3 - 2 * t);
}

export interface ActorInkBoundsPixels {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface ActorPhysicalMetrics {
  readonly kind: UniversalActorKind;
  readonly inkBoundsPixels: ActorInkBoundsPixels;
  readonly atlasWidthPixels: number;
  readonly atlasHeightPixels: number;
  readonly anchorXPixels: number;
  readonly anchorYPixels: number;
  readonly bodyHeightMeters: number | null;
  readonly bodyLengthMeters: number | null;
  readonly bodyWidthMeters: number;
  readonly atlasQuadWidthMeters: number;
  readonly atlasQuadHeightMeters: number;
  readonly metersPerPixelX: number;
  readonly metersPerPixelY: number;
  readonly groundClearanceMeters: number;
}

function metrics(
  kind: UniversalActorKind,
  inkBoundsPixels: ActorInkBoundsPixels,
  bodyWidthMeters: number,
): ActorPhysicalMetrics {
  const person = kind === 'person';
  const atlasWidthPixels = 32;
  const atlasHeightPixels = person ? 64 : 32;
  const inkHeightPixels = inkBoundsPixels.bottom - inkBoundsPixels.top;
  const metersPerPixelY = (person ? ADULT_INK_HEIGHT_METERS : VEHICLE_INK_LENGTH_METERS)
    / inkHeightPixels;
  const metersPerPixelX = bodyWidthMeters / (inkBoundsPixels.right - inkBoundsPixels.left);
  return Object.freeze({
    kind,
    inkBoundsPixels: Object.freeze(inkBoundsPixels),
    atlasWidthPixels,
    atlasHeightPixels,
    anchorXPixels: 16,
    anchorYPixels: person ? 56 : 16,
    bodyHeightMeters: person ? ADULT_INK_HEIGHT_METERS : null,
    bodyLengthMeters: person ? null : VEHICLE_INK_LENGTH_METERS,
    bodyWidthMeters,
    atlasQuadWidthMeters: atlasWidthPixels * metersPerPixelX,
    atlasQuadHeightMeters: atlasHeightPixels * metersPerPixelY,
    metersPerPixelX,
    metersPerPixelY,
    groundClearanceMeters: person ? 0 : VEHICLE_GROUND_CLEARANCE_METERS,
  });
}

/**
 * Body-ink bounds from omnitwin-actor-atlas-v1.svg, in each original tile's
 * local pixel coordinates. Ellipses and their blurred shadows are excluded.
 * Person bounds are the union of all eight appearance/gait tiles. The head
 * circle starts at y=9 and every gait has a foot at y=56, so its body is 47px.
 * Normal vehicle rear Q(24,27; 16,31; 8,27) reaches y=29 at t=0.5, not 31.
 * Wide rear Q(25,27; 16,30; 7,27) reaches y=28.5, not 30.
 * Car transverse scaling is deliberately independent of the stylized atlas
 * aspect: a 4.5m body is 1.8m wide, or 2m for the wider appearance family.
 */
export const ACTOR_PHYSICAL_METRICS = Object.freeze({
  person: metrics('person', { left: 6, top: 9, right: 27, bottom: 56 }, 21 / 47 * 1.8),
  vehicleNormal: metrics('vehicle', { left: 6, top: 2, right: 26, bottom: 29 }, 1.8),
  vehicleWide: metrics('vehicle', { left: 5, top: 2, right: 27, bottom: 28.5 }, 2),
});

/** Physical body scale intentionally has no focus, selection, zoom or pixel-size input. */
export function actorPhysicalMetrics(
  kind: UniversalActorKind,
  appearance = 0,
): ActorPhysicalMetrics {
  if (!Number.isInteger(appearance) || appearance < 0 || appearance >= 8) {
    throw new RangeError('Actor appearance must be an integer atlas slot from 0 to 7');
  }
  if (kind === 'person') return ACTOR_PHYSICAL_METRICS.person;
  if (kind === 'vehicle') {
    return appearance < 4
      ? ACTOR_PHYSICAL_METRICS.vehicleNormal
      : ACTOR_PHYSICAL_METRICS.vehicleWide;
  }
  throw new RangeError('Actor kind must be person or vehicle');
}

export type ActorPlanePoint3 = readonly [number, number, number];
export type ActorPlaneQuad3 = readonly [
  ActorPlanePoint3, ActorPlanePoint3, ActorPlanePoint3, ActorPlanePoint3,
];

export interface ActorPlaneOptions {
  readonly kind: UniversalActorKind;
  readonly appearance?: number;
  /** Ground anchor in local world metres. */
  readonly origin?: ActorPlanePoint3;
  /** Horizontal camera-right vector; normalized without introducing world-Z tilt. */
  readonly cameraRight?: readonly [number, number];
  /** Vehicle bearing clockwise from north (+Y); 90 degrees points east (+X). */
  readonly headingDegrees?: number;
}

export interface ActorPlanePointOptions extends ActorPlaneOptions {
  /** Original, uncropped atlas-tile coordinates, not normalized UV coordinates. */
  readonly atlasX: number;
  readonly atlasY: number;
}

/**
 * Pure reference geometry for the GPU actor shader. People are cylindrical
 * billboards: horizontal camera-right plus world Z, with opaque feet at Z=0.
 * Cars are anisotropic XY quads at ground+0.1m. This does not sample terrain.
 * The complete person atlas includes below-foot shadow padding; crop it to
 * y=9..56 for display instead of lifting the person to accommodate that shadow.
 */
export function actorPlanePoint(options: ActorPlanePointOptions): ActorPlanePoint3 {
  const model = actorPhysicalMetrics(options.kind, options.appearance);
  const { atlasX, atlasY } = options;
  const origin = options.origin ?? [0, 0, 0];
  const headingDegrees = options.headingDegrees ?? 0;
  if (
    !Number.isFinite(atlasX) || atlasX < 0 || atlasX > model.atlasWidthPixels
    || !Number.isFinite(atlasY) || atlasY < 0 || atlasY > model.atlasHeightPixels
    || !origin.every(Number.isFinite) || !Number.isFinite(headingDegrees)
  ) {
    throw new RangeError('Actor plane coordinates must be finite and inside the atlas tile');
  }
  const horizontal = (atlasX - model.anchorXPixels) * model.metersPerPixelX;
  const vertical = (model.anchorYPixels - atlasY) * model.metersPerPixelY;
  if (options.kind === 'person') {
    const right = options.cameraRight ?? [1, 0];
    const length = Math.hypot(right[0], right[1]);
    if (!right.every(Number.isFinite) || !Number.isFinite(length) || length === 0) {
      throw new RangeError('Actor camera-right vector must be finite and nonzero');
    }
    return [
      origin[0] + horizontal * right[0] / length,
      origin[1] + horizontal * right[1] / length,
      origin[2] + vertical,
    ];
  }
  const angle = (headingDegrees % 360) * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    origin[0] + horizontal * cosine + vertical * sine,
    origin[1] - horizontal * sine + vertical * cosine,
    origin[2] + model.groundClearanceMeters,
  ];
}

/**
 * Corners in original image order: top-left, top-right, bottom-right, bottom-left.
 * `visible` crops person padding/shadow vertically, retaining full tile width;
 * `body` returns the body-ink bounding rectangle; `atlas` includes all padding.
 */
export function actorPlaneQuad(
  options: ActorPlaneOptions,
  extent: 'visible' | 'body' | 'atlas' = 'visible',
): ActorPlaneQuad3 {
  const model = actorPhysicalMetrics(options.kind, options.appearance);
  const bounds = extent === 'body'
    ? model.inkBoundsPixels
    : {
      left: 0,
      top: extent === 'visible' && options.kind === 'person' ? model.inkBoundsPixels.top : 0,
      right: model.atlasWidthPixels,
      bottom: extent === 'visible' && options.kind === 'person'
        ? model.inkBoundsPixels.bottom
        : model.atlasHeightPixels,
    };
  return [
    actorPlanePoint({ ...options, atlasX: bounds.left, atlasY: bounds.top }),
    actorPlanePoint({ ...options, atlasX: bounds.right, atlasY: bounds.top }),
    actorPlanePoint({ ...options, atlasX: bounds.right, atlasY: bounds.bottom }),
    actorPlanePoint({ ...options, atlasX: bounds.left, atlasY: bounds.bottom }),
  ];
}
