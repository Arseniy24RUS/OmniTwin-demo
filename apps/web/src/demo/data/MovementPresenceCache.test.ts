import {expect,it} from 'vitest';
import {encodePersonShard,decodePersonShard,recordAt,SCENARIO_IDS} from '../../../../../shared/demo-population/index.mjs';
import {presenceFor,householdHasVehicle} from '../../../../../shared/demo-population/spatial.mjs';
import {MovementPresenceCache} from './MovementPresenceCache';
const household=Array.from({length:100},(_,i)=>i).find(householdHasVehicle)!;
function family(){const bytes=encodePersonShard(0,Array.from({length:9},(_,i)=>({householdIndex:household,birthYear:i===8?2027:1980+i*5,sex:i%2?'female' as const:'male' as const,householdRole:i?'child' as const:'head' as const,scenarioMask:i===8?1:7,entryYear:i===8?2027:2026,entryReason:i===8?'birth' as const:'initial' as const,exitYears:i===0?[2029,null,null]:[null,null,null],exitReasons:i===0?['death',null,null]:[null,null,null]})));const decoded=decodePersonShard(bytes);return Array.from({length:9},(_,i)=>recordAt(decoded,i));}
const targets={workBuildingIndex:2,studyBuildingIndex:null,visitorBuildingIndex:3};
it('matches the pinned presence rule across every minute, year, scenario and shared passenger cap',()=>{
 const records=family(),cache=new MovementPresenceCache();let compared=0;
 for(const year of [2026,2027,2029,2036])for(const scenario of SCENARIO_IDS)for(let minute=0;minute<1440;minute++)for(const record of [records[0]!,records[1]!,records[7]!,records[8]!]){
  const expected=presenceFor(record,targets,0,year,scenario,minute,{householdRecords:records}),actual=cache.presence(record,targets,0,year,scenario,minute,records);
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error(`Presence mismatch ${year}/${scenario}/${minute}/${record.id}`);compared++;
 }
 expect(compared).toBe(69120);expect(cache.stats.computations).toBe(12);expect(cache.stats.hits).toBeGreaterThan(50000);
});
it('reuses only one year/scenario result per immutable household array and keeps changed membership independent',()=>{
 const records=family(),cache=new MovementPresenceCache();
 for(const record of records)cache.presence(record,targets,0,2026,'baseline',1220,records);
 expect(cache.stats.computations).toBe(1);
 cache.presence(records[0]!,targets,0,2027,'baseline',1220,records);expect(cache.stats.computations).toBe(2);
 cache.presence(records[0]!,targets,0,2027,'inflow',1220,records);expect(cache.stats.computations).toBe(3);
 const changed=records.slice(1);expect(cache.presence(changed[0]!,targets,0,2027,'inflow',1220,changed)).toEqual(presenceFor(changed[0]!,targets,0,2027,'inflow',1220,{householdRecords:changed}));expect(cache.stats.computations).toBe(4);
});
it('retains source validation and absent/inactive/unplaced behavior',()=>{
 const records=family(),cache=new MovementPresenceCache(),record=records[0]!;
 expect(()=>cache.presence(record,targets,0,2026,'baseline',-1,records)).toThrow('Invalid presence time');
 expect(()=>cache.presence(record,targets,0,2026,'baseline',720,[])).toThrow('Invalid household trip records');
 expect(cache.presence(record,targets,null,2026,'baseline',720,[])).toEqual(presenceFor(record,targets,null,2026,'baseline',720,{householdRecords:[]}));
 expect(cache.presence(records[8]!,targets,0,2026,'baseline',720,[])).toEqual(presenceFor(records[8]!,targets,0,2026,'baseline',720,{householdRecords:[]}));
 expect(cache.presence(record,targets,0,2026,'baseline',720)).toEqual(presenceFor(record,targets,0,2026,'baseline',720));
});
