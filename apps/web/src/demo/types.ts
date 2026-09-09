/** Public, entirely fictional demo contracts. They never contain research microdata. */
export type DemoScenarioId = 'baseline' | 'inflow' | 'ageing';
export type DemoSex = 'male' | 'female';
export type DemoAgeBand = '0-17' | '18-34' | '35-54' | '55-69' | '70+';
export type DemoEmployment = 'child' | 'student' | 'employed' | 'retired' | 'not_employed';
export type DemoWeather = 'clear' | 'cloudy' | 'rain' | 'snow';
export interface DemoCohort { ageBand?: DemoAgeBand; sex?: DemoSex; employment?: DemoEmployment }
export interface DemoContextV1 {
  /** Independent presentation backend. The experimental pack is opt-in until visual acceptance. */
  cityGraphicsBackend?: 'native_map' | 'tiled_game';
  datasetId: string;
  /** Public city observations and fictional scenario states have separate dates. */
  analyticsSource?: 'observed' | 'fictional';
  observedYear?: number;
  scenario: DemoScenarioId;
  comparisonScenario?: DemoScenarioId;
  agentQuery?: string;
  agentOffset?: number;
  year: number;
  territoryId: string;
  cohort: DemoCohort | null;
  /** Minutes since midnight, independent from demographic year. */
  presentationMinutes: number;
  /** Runtime-only explicit time command, not serialized into share URLs. */
  presentationSeekRevision?: number;
  weather: DemoWeather;
  playing: boolean;
  speed: number;
  camera: { longitude: number; latitude: number; zoom: number; pitch: number; bearing: number };
}
export interface DemoTerritory { id: string; name: string; parentId: string | null }
export interface DemoScenario { id: DemoScenarioId; label: string; description: string; scientificClaim: false }
export interface DemoAsset {
  url: string; sha256: string; bytes: number; rows?: number;
  /** Explicit gzip file bytes, served as application/gzip without Content-Encoding. */
  gzip?: { url: string; sha256: string; bytes: number };
}
export interface DemoDatasetManifestV1 {
  contract: 'DemoDatasetManifestV1';
  datasetId: string;
  version: string;
  representation: 'fictional_demo';
  scientificClaim: false;
  predictiveValidation: false;
  startYear: number;
  endYear: number;
  initialPopulation: number;
  seed: number;
  assets: Record<string, DemoAsset>;
  provenance: { source: string; notes: string; sourceHashes: Record<string, string> };
  licenses: string[];
}
export interface DemoAgeSexRow { ageBand: DemoAgeBand; male: number; female: number }
export interface DemoSnapshot {
  datasetId: string;
  scenario: DemoScenarioId;
  year: number;
  stockAsOf: string;
  territoryId: string;
  population: number;
  ageSex: DemoAgeSexRow[];
  /** Events in [year - 1, year). null means no preceding demo transition exists. */
  births: number | null;
  deaths: number | null;
  immigration: number | null;
  emigration: number | null;
  internalIn: number | null;
  internalOut: number | null;
  netChange: number | null;
  employment: Record<DemoEmployment, number>;
  households: number | null;
  representation: 'fictional_demo';
}
export interface DemoScenarioComparisonV1 {
  contract: 'DemoScenarioComparisonV1';
  left: DemoSnapshot;
  right: DemoSnapshot;
  populationDelta: number;
  populationDeltaPercent: number | null;
  scientificClaim: false;
}
export interface PublicFictionalPersonV1 {
  contract: 'PublicFictionalPersonV1';
  id: string;
  name: string;
  age: number;
  ageBand: DemoAgeBand;
  sex: DemoSex;
  employment: DemoEmployment;
  occupation: string;
  householdId: string;
  householdSize: number | null;
  territoryId: string;
  territoryName: string;
  biography: string;
  interests: string[];
  scenario: DemoScenarioId;
  demographicYear: number;
  datasetId: string;
  representation: 'fictional_demo';
  spatialRepresentation: 'visual_synthesis';
  isFictional: true;
}
export interface DemoPeopleQuery extends DemoCohort {
  scenario?: DemoScenarioId;
  year?: number;
  territoryId?: string;
  query?: string;
  offset?: number;
  limit?: number;
}
export interface DemoViewportQuery extends DemoCohort {
  longitude: number;
  latitude: number;
  radiusMeters: number;
  minutes: number;
  territoryId?: string;
}
export interface DemoPage<T> { items: T[]; total: number; offset: number; limit: number; nextOffset: number | null }
export interface DemoLayout {
  buildings: Array<{ id: string; center: [number, number]; use?: 'residential' | 'work' | 'study' | 'mixed' | 'unknown'; name?: string | null; index?: number; aliases?: string[]; districtId?: string | null; areaM2?: number; levels?: number | null; heightM?: number }>;
  roads: Array<{ id: string; coordinates: Array<[number, number]>; oneway?: boolean; walkable?: boolean; drivable?: boolean;
    /** Exact source-road ownership of a connected presentation corridor. */
    sourceRoadIds?: readonly string[];
    segments?: readonly { roadId?: string; fromNodeId: string; toNodeId: string | null;
      startVertex?: number; endVertex?: number; direction?: 'forward' | 'reverse' }[];
  }>;
}
export type DemoPresenceState = 'home' | 'work' | 'study' | 'shopping' | 'leisure' | 'outdoor' | 'vehicle' | 'unplaced';
export interface DemoPresence {
  personId: string;
  state: DemoPresenceState;
  buildingId: string | null;
  vehicleId: string | null;
  roadId: string | null;
  position: [number, number] | null;
  routeProgress?: number;
  direction?: 'forward' | 'reverse';
  speedMps?: number;
  /** Provider-authored source-corridor traversal; absent only for legacy fixtures. */
  routeMode?: 'ping_pong' | 'loop' | 'once';
  /** Display-only endpoint fade metadata; not a presence/population weight. */
  endpointOpacity?: number;
  activity: string;
  representation: 'visual_synthesis';
}
export interface DemoVehicle {
  id: string;
  label: string;
  class: 'sedan' | 'hatchback' | 'minivan';
  occupants: PublicFictionalPersonV1[];
  occupancy: number;
  capacity: number;
  roadId: string;
  representation: 'visual_synthesis';
}
export interface DemoBuildingOccupancy extends DemoPage<PublicFictionalPersonV1> {
  buildingId: string;
  /** V2 distinguishes a verified empty roster from an absent source-backed index. */
  coverageStatus?: 'covered' | 'no_index';
  assignedResidents: number;
  assignedWorkers: number;
  assignedStudents?: number;
  visitorsNow?: number;
  presentNow: number;
  representation: 'visual_synthesis';
}
/** Private fixture records are still fictional; no original model IDs exist here. */
export interface DemoPersonRecord {
  id: string;
  birthYear: number;
  sex: DemoSex;
  householdId: string;
  territoryId: string;
  entryYear: number;
  exitYear: number | null;
  entryReason: 'initial' | 'birth' | 'immigration';
  exitReason: 'death' | 'emigration' | null;
}
export interface DemoScenarioData { id: DemoScenarioId; people: DemoPersonRecord[]; snapshots: DemoSnapshot[] }
export interface DemoDataset {
  datasetId: string;
  territories: DemoTerritory[];
  scenarios: DemoScenario[];
  data: Record<DemoScenarioId, DemoScenarioData>;
}
export interface DemoLegacyExport {
  contract: 'OriginalSyntheticBundleExportV1';
  sourceRunId: 'synthetic-chelyabinsk-v1';
  run: Record<string, unknown>;
  completion: Record<string, unknown>;
  geography: Array<Record<string, unknown>>;
  population: Array<Record<string, unknown>>;
  events_aggregate: Array<Record<string, unknown>>;
}
