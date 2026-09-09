export interface GameRoadWidthSource {
  readonly widthM?: unknown;
  readonly width?: unknown;
  readonly lanes?: unknown;
  readonly className?: string;
  readonly drivable?: boolean;
  readonly properties?: Readonly<Record<string, unknown>> | null;
  readonly sourceAttributes?: Readonly<Record<string, unknown>>;
  readonly tags?: Readonly<Record<string, unknown>>;
}
/** Shared physical display widths for surfaces and vegetation exclusion, not road measurements. */
export const GAME_ROAD_CLASS_WIDTHS: Readonly<Record<string, number>> = Object.freeze({
  motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 8, residential: 6, unclassified: 6,
  road: 6, living_street: 5, service: 4, track: 3, pedestrian: 5, footway: 2, path: 1.5,
  cycleway: 2.5, steps: 2, corridor: 2, platform: 3,
});
export function resolveGameRoadWidth(road: GameRoadWidthSource): { width: number; source: 'source' | 'lanes' | 'class'; invalidSourceWidth: boolean } {
  const raw = road.widthM ?? road.width ?? road.sourceAttributes?.width ?? road.properties?.width ?? road.tags?.width;
  const width = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+(?:\.\d+)?\s*(?:m)?\s*$/u.test(raw) ? parseFloat(raw) : NaN;
  if (Number.isFinite(width) && width >= .3 && width <= 40) return { width, source: 'source', invalidSourceWidth: false };
  const lanes = Number(road.lanes ?? road.properties?.lanes ?? road.sourceAttributes?.lanes);
  if (road.drivable !== false && Number.isInteger(lanes) && lanes >= 1 && lanes <= 12) {
    return { width: lanes * 3 + .6, source: 'lanes', invalidSourceWidth: raw !== undefined };
  }
  const className = String(road.className ?? road.properties?.class ?? road.properties?.highway ?? 'road').toLowerCase();
  return { width: GAME_ROAD_CLASS_WIDTHS[className] ?? (road.drivable === false ? 2 : 5), source: 'class', invalidSourceWidth: raw !== undefined };
}
