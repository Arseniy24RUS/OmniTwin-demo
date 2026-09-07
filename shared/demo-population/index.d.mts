export type Scenario = 'baseline' | 'inflow' | 'ageing';
export interface CompactPerson { personIndex: number; id: string; householdIndex: number; householdId: string; birthYear: number; sex: 'male' | 'female'; householdRole: 'head' | 'partner' | 'child' | 'other'; scenarioMask: number; entryYear: number; entryReason: 'initial' | 'birth' | 'immigration'; exitYears: (number | null)[]; exitReasons: ('death' | 'emigration' | null)[] }
export interface DecodedShard { bytes: Uint8Array; view: DataView; startIndex: number; count: number; stride: number; memberCount: number; offsetStart?: number; memberStart?: number }
export interface Household { householdIndex: number; homeBuildingIndex: number | null; districtIndex: number | null; members: number[] }
export const DATASET_ID: 'omnitwin-fictional-city-v2';
export const BASE_YEAR: 2026; export const END_YEAR: 2036;
export const PERSON_SHARD_SIZE: 8192; export const HOUSEHOLD_SHARD_SIZE: 4096; export const RECORD_BYTES: 16; export const HEADER_BYTES: 32;
export const SCENARIO_IDS: readonly Scenario[]; export const DISTRICT_IDS: readonly string[];
export function personId(index: number): string; export function householdId(index: number): string; export function parsePersonId(id: string): number | null;
export function scenarioIndex(scenario: Scenario): number; export function hashIndex(index: number, seed?: number): number; export function stableHash(value: string): number;
export function writePersonRecord(view: DataView, offset: number, record: Omit<CompactPerson, 'personIndex' | 'id' | 'householdId'>): void;
export function encodePersonShard(startIndex: number, records: Uint8Array | Partial<CompactPerson>[]): Uint8Array;
export function decodePersonShard(bytes: ArrayBuffer | ArrayBufferView): DecodedShard;
export function recordAt(shard: DecodedShard, index: number): CompactPerson;
export function isActive(record: CompactPerson, year: number, scenario: Scenario): boolean;
export function recordForScenario(record: CompactPerson, scenario: Scenario): CompactPerson & { exitYear: number | null; exitReason: 'death' | 'emigration' | null };
export function encodeHouseholdShard(startIndex: number, households: Omit<Household, 'householdIndex'>[]): Uint8Array;
export function decodeHouseholdShard(bytes: ArrayBuffer | ArrayBufferView): DecodedShard;
export function householdMembers(shard: DecodedShard, index: number): Household;
export function coarseAgeBand(age: number): '0-17' | '18-34' | '35-54' | '55-69' | '70+';
export function employmentFor(record: Pick<CompactPerson, 'birthYear' | 'personIndex'>, year: number): 'child' | 'student' | 'employed' | 'retired' | 'not_employed';
export function profileFor(record: CompactPerson, year: number, scenario: Scenario, context: { householdSize: number; territoryId?: string; territoryName?: string }): { contract: 'PublicFictionalPersonV1'; id: string; name: string; age: number; ageBand: ReturnType<typeof coarseAgeBand>; sex: 'male' | 'female'; employment: ReturnType<typeof employmentFor>; occupation: string; householdId: string; householdSize: number; territoryId: string; territoryName: string; biography: string; interests: string[]; scenario: Scenario; demographicYear: number; datasetId: 'omnitwin-fictional-city-v2'; representation: 'fictional_demo'; spatialRepresentation: 'visual_synthesis'; isFictional: true };
