import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';

/** Separate source identity; never reinterpret basemap MVT feature IDs as these IDs. */
export const VERIFIED_CITY_BUILDING_PROVIDER_ID = 'verified_city_buildings' as const;

export interface VerifiedCityBuildingSnapshot {
  datasetVersion: string;
  /** Content fingerprint excluding coverage/diagnostics; not source-asset cryptographic verification. */
  signature: string;
  data: FeatureCollection<Polygon | MultiPolygon>;
  canonicalIds: ReadonlySet<string>;
  cells: readonly string[];
  coverage: 'complete_viewport' | 'partial_viewport' | 'unresolved';
  /** Proven rectangle of retained source cells, allowing camera movement without a rebuild. */
  coverageBounds?: readonly [number, number, number, number] | null;
  /** Source rows omitted by explicit limits, before deduplication; not a population statistic. */
  omittedBuildings: number;
  /** Structurally invalid source rows, including rows in malformed cells. */
  invalidBuildings: number;
  vertexCount: number;
}
