/** Presentation policy, not measured traffic demand or pedestrian access law. */
export const MOVEMENT_ROAD_POLICY_VERSION='osm-source-mode-v2';
const WALK=new Set(['footway','pedestrian','path','steps','corridor','platform','bridleway','living_street']);
const NO_CAR=new Set(['footway','pedestrian','path','steps','corridor','platform','bridleway','cycleway']);
const ROAD_WEIGHT={motorway:4,trunk:4,primary:4,secondary:3,tertiary:2.4,unclassified:1.4,residential:1.4,living_street:.8,service:.35,track:.25};
const denied=v=>['no','private','use_sidepath'].includes(String(v??'').toLowerCase());

/** Only source pedestrian lines/shared-space geometry: foot=yes on a car centerline is not a sidewalk.
 * https://wiki.openstreetmap.org/wiki/Key:sidewalk
 * https://wiki.openstreetmap.org/wiki/Key:oneway:foot
 * walkDirection is explicitly normalized relative to the retained coordinate order.
 */
export function roadModePolicy(road,mode){
 if(!['walk','car'].includes(mode))throw new Error('Unknown movement mode');
 const tags=road?.sourceAttributes??road?.tags??{},kind=String(road?.className??tags.highway??''),walk=mode==='walk';
 const specific=walk?tags.foot:tags.motor_vehicle??tags.vehicle;
 let reason=null;
 if(road?.[walk?'walkable':'drivable']!==true)reason='source_mode_not_allowed';
 else if(denied(specific)||specific===undefined&&denied(tags.access))reason='source_access_restricted';
 else if(walk&&!WALK.has(kind))reason='no_source_pedestrian_geometry';
 else if(!walk&&NO_CAR.has(kind))reason='non_motor_geometry';
 const eligible=reason===null;
 let forward=true,reverse=true,directionProvenance='mode_default';
 if(!walk){reverse=!road?.oneway;directionProvenance='normalized_source_vehicle_oneway';}
 else if(['forward','reverse','both'].includes(road.walkDirection)){forward=road.walkDirection!=='reverse';reverse=road.walkDirection!=='forward';directionProvenance='normalized_source_pedestrian_oneway';}
 // Plain oneway on footway/path is ambiguous in OSM; retain conservatively.
 else if(road.oneway&&kind!=='living_street'){reverse=false;directionProvenance='ambiguous_pedestrian_oneway_retained';}
 return {eligible,forward:eligible&&forward,reverse:eligible&&reverse,className:kind,reason,directionProvenance,geometry:walk?'source_pedestrian_or_shared_space':'source_motor_road',policyVersion:MOVEMENT_ROAD_POLICY_VERSION};
}

/** Bounded illustrative allocation score, never an observed count, capacity or per-person weight. */
export function roadVisualWeight(road,mode,{lengthMeters=120,connectedExits=2}={}){
 if(!roadModePolicy(road,mode).eligible)return 0;
 const kind=String(road.className??'').replace(/_link$/,''),base=mode==='car'?(ROAD_WEIGHT[kind]??1):kind==='pedestrian'?1.4:kind==='steps'?.55:kind==='living_street'?.6:1;
 const lanes=mode==='car'&&Number.isFinite(road.lanes)?Math.max(.75,Math.min(1.5,road.lanes/2)):1;
 const length=Math.max(.15,Math.min(1,Math.sqrt(Math.max(0,lengthMeters)/120)));
 return base*lanes*length*(connectedExits<2?.25:1);
}
