export const MOVEMENT_ROAD_POLICY_VERSION:'osm-source-mode-v2';
export interface MovementSourceRoad {id?:string;className?:string;walkable:boolean;drivable:boolean;oneway:boolean;lanes?:number|null;walkDirection?:'forward'|'reverse'|'both';sourceAttributes?:Record<string,string>;tags?:Record<string,string>}
export interface RoadModePolicy {eligible:boolean;forward:boolean;reverse:boolean;className:string;reason:string|null;directionProvenance:string;geometry:string;policyVersion:typeof MOVEMENT_ROAD_POLICY_VERSION}
export function roadModePolicy(road:MovementSourceRoad,mode:'walk'|'car'):RoadModePolicy;
export function roadVisualWeight(road:MovementSourceRoad,mode:'walk'|'car',info?:{lengthMeters?:number;connectedExits?:number}):number;
