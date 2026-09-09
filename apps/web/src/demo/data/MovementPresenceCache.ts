import type {CompactPerson,Scenario} from '../../../../../shared/demo-population/index.mjs';
import {householdTripFor,presenceFor,type HouseholdTrip,type SpatialTargets,type SpatialPresence} from '../../../../../shared/demo-population/spatial.mjs';

/** Verified household arrays are immutable snapshots. A weak key retains no
 * evicted page/person inventory; each live array keeps only its latest context.
 * All schedule rules stay in the pinned shared codec. The participant option is
 * its existing roster API; shared-trip identity fields come from that same codec.
 */
export class MovementPresenceCache {
  private readonly trips=new WeakMap<CompactPerson[],{year:number;scenario:Scenario;trip:HouseholdTrip|null}>();
  private computations=0;
  private hits=0;
  get stats(){return {computations:this.computations,hits:this.hits,contextsPerHousehold:1 as const};}

  presence(record:CompactPerson,targets:SpatialTargets,home:number|null,year:number,scenario:Scenario,minutes:number,householdRecords?:CompactPerson[]):SpatialPresence {
    // Preserve original validation and early inactive/unplaced behavior before
    // inspecting household data. Nonparticipants use this exact result directly.
    const ordinary=presenceFor(record,targets,home,year,scenario,minutes);
    if(!householdRecords||!ordinary.active||home===null)return ordinary;
    let cached=this.trips.get(householdRecords);
    if(!cached||cached.year!==year||cached.scenario!==scenario){
      cached={year,scenario,trip:householdTripFor(householdRecords,year,scenario)};
      this.trips.set(householdRecords,cached);this.computations++;
    }else this.hits++;
    const trip=cached.trip;
    if(trip&&trip.householdIndex!==record.householdIndex)throw new Error('Presence household mismatch.');
    if(!trip?.passengerIndices.includes(record.personIndex))return ordinary;
    const current=presenceFor(record,targets,home,year,scenario,minutes,{householdTripParticipant:true});
    return current.tripPurpose==='shared_household_source_road_outing'
      ?{...current,vehicleDriverIndex:trip.driverPersonIndex,vehicleId:trip.vehicleId,passengerIndices:trip.passengerIndices}:current;
  }
}
