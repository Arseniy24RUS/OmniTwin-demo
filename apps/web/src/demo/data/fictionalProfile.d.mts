import type { DemoAgeBand, DemoEmployment, DemoPersonRecord, DemoScenarioId, PublicFictionalPersonV1 } from '../types';
export function stableHash(value: string): number;
export function ageBandFor(age: number): DemoAgeBand;
export function employmentFor(record: DemoPersonRecord, year: number): DemoEmployment;
export function fictionalProfile(record: DemoPersonRecord, year: number, scenario: DemoScenarioId, datasetId: string, householdSize: number, territoryName: string): PublicFictionalPersonV1;
