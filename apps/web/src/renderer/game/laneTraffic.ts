import { JunctionTraffic, type JunctionKind, type JunctionPath } from './junctionTraffic';
import {OpposingLaneReservations,type OpposingLanePath} from './opposingLaneReservations';
type Point = readonly [number, number];
export interface LaneTrafficVehicle {
  readonly id: string;
  readonly routeKey: string;
  /** Existing source path, ordered in the vehicle's authored travel direction. */
  readonly path: readonly Point[];
  readonly sourceDistance: number;
  readonly sourceTime: number;
  readonly sourceSpeed: number;
  readonly laneSpeed: number;
  readonly singleLaneKey?:string;
  /** Undisplaced author arclength for phase continuity on a parallel display lane. */
  readonly sourcePhase?:{readonly distance:number;readonly length:number;readonly speed:number};
  readonly traversal?:'once'|'ping_pong';
  readonly sourceDirection?:'forward'|'reverse';
  readonly kind?: JunctionKind;
  readonly atGrade?: boolean;
  readonly roadHalfWidthMeters?: number;
  readonly signalOffsetMeters?: number;
  readonly reverseSignalOffsetMeters?: number;
  readonly sourceCorridorKey?:string;
}
export interface LaneTrafficSample { readonly distance: number; readonly length: number; readonly point: Point; readonly heading: number; readonly visible: boolean; readonly speed: number;readonly traversal:'once'|'ping_pong' }
interface PathSegment { length: number; key: string; stationStart: number; stationEnd: number; heading: number }
interface Path { points: readonly Point[]; distances: number[]; length: number; key: string; segmentKeys: string[]; segments: PathSegment[];
  junctionKeys: Partial<Record<JunctionKind, string>> }
interface State { input: LaneTrafficVehicle; path: Path;basePath:Path;reversePath:Path;reversed:boolean; distance: number; fresh: boolean; entered: boolean; speed: number; junctionFresh:boolean; junctionBlocked:boolean }
const HEADWAY = 8;
const pointKey = (point: Point) => `${Math.round(point[0] * 100000)},${Math.round(point[1] * 100000)}`;
function compilePath(points: readonly Point[]): Path {
  if (points.length < 2 || points.length > 8192 || points.some(p => p.length !== 2 || !p.every(Number.isFinite))) throw Error('Invalid source traffic path');
  const distances = [0], segmentKeys: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < .00001) throw Error('Degenerate source traffic segment');
    distances.push(distances.at(-1)! + length); segmentKeys.push(`${pointKey(a)}>${pointKey(b)}`);
  }
  const segments: PathSegment[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    // Use the original location() subtraction after cumulative summation, not
    // raw hypot: its floating-point rounding is part of existing lane identity.
    const length = distances[i]! - distances[i - 1]!;
    const dx = (b[0] - a[0]) / length, dz = (b[1] - a[1]) / length;
    const stationStart = a[0] * dx + a[1] * dz;
    segments.push({ length, key: `${Math.round(Math.atan2(dz,dx)*1e8)}:${Math.round((-a[0]*dz+a[1]*dx)*100000)}`,
      stationStart, stationEnd: stationStart + length,
      heading: (Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180 / Math.PI + 360) % 360 });
  }
  return { points, distances, length: distances.at(-1)!, key: points.map(pointKey).join(';'), segmentKeys, segments, junctionKeys: {} };
}
function location(path: Path, distance: number) {
  distance = Math.min(path.length, Math.max(0, distance));
  let low = 1, high = path.points.length - 1;
  while (low < high) { const mid = (low + high) >>> 1; if (path.distances[mid]! < distance) low = mid + 1; else high = mid; }
  const a = path.points[low - 1]!, b = path.points[low]!, start = path.distances[low - 1]!, along = distance - start;
  const segment = path.segments[low - 1]!, length = segment.length, t = along / length;
  // Numeric equality of a directed source supporting line, with a 10 micrometre
  // round-off tolerance. Overlapping authored intervals are checked separately;
  // a merely nearby or disjoint road does not become the same lane.
  return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as Point,
    key: segment.key, along, start, station:segment.stationStart+along,stationStart:segment.stationStart,stationEnd:segment.stationEnd,
    heading: segment.heading };
}
type Location=ReturnType<typeof location>;
const sameLane=(a:Location,b:Location)=>a.key===b.key&&Math.max(a.stationStart,b.stationStart)<=Math.min(a.stationEnd,b.stationEnd)+.00001;
function safeBehind(path:Path,leader:Point,minimum:number,maximum:number):number{
  const clear=(distance:number)=>{const point=location(path,distance).point;return Math.hypot(point[0]-leader[0],point[1]-leader[1])>=HEADWAY;};
  if(maximum<=minimum||clear(maximum))return maximum;
  if(!clear(minimum))return minimum;
  let low=minimum,high=maximum;
  for(let i=0;i<24;i++){const middle=(low+high)/2;if(clear(middle))low=middle;else high=middle;}
  return low;
}
const modulo=(value:number,length:number)=>((value%length)+length)%length;
const sourceAt = (state: State, time: number) => state.input.traversal==='ping_pong'
  ?modulo(state.input.sourceDistance+state.input.sourceSpeed*(time-state.input.sourceTime),state.basePath.length)
  :Math.min(state.path.length, Math.max(0, state.input.sourceDistance + state.input.sourceSpeed * (time - state.input.sourceTime)));
function sourcePosition(state:State,time:number):void{
  if(state.input.traversal==='ping_pong'){
    const length=state.basePath.length,phase=modulo((state.input.sourceDirection==='reverse'?length:0)+state.input.sourceDistance+state.input.sourceSpeed*(time-state.input.sourceTime),2*length);
    state.reversed=phase>=length;state.path=state.reversed?state.reversePath:state.basePath;state.distance=phase%length;
  }else{state.reversed=false;state.path=state.basePath;state.distance=sourceAt(state,time);}
}
const active = (state: State) => state.entered && (state.input.traversal==='ping_pong'||state.distance < state.path.length - 1e-7);
const vehicle = (state: State) => state.input.kind !== 'pedestrian';
const junctionKey = (state: State, path = state.path) => {
  const kind = state.input.kind ?? 'vehicle';
  // Preserve the exact geometry identity, but hash its long string only once
  // per compiled path/kind rather than once per actor in every safety substep.
  return path.junctionKeys[kind] ??= `${kind}:${path.key}`;
};
function groups(states: Iterable<State>, key: (state: State) => string) {
  const result = new Map<string, State[]>();
  for (const state of states) if (active(state)) { const id = key(state), list = result.get(id) ?? []; list.push(state); result.set(id, list); }
  return result;
}
function sharedGroups(states:Iterable<State>,distances?:ReadonlyMap<State,number>):State[][]{
  // All states/distances are immutable for this grouping call. Reuse the same
  // location in keying, sort comparisons and interval partitioning.
  const positions = new Map<State, Location>();
  const atState = (state: State) => {
    let at = positions.get(state);
    if (!at) { at = location(state.path, distances?.get(state) ?? state.distance); positions.set(state, at); }
    return at;
  };
  const lines=groups(states,state=>atState(state).key),result:State[][]=[];
  for(const group of lines.values()){
    group.sort((a,b)=>atState(a).stationStart-atState(b).stationStart);
    let component:State[]=[],end=-Infinity;
    for(const state of group){const at=atState(state);
      if(at.stationStart>end+.00001&&component.length){result.push(component);component=[];}
      component.push(state);end=Math.max(end,at.stationEnd);
    }
    if(component.length)result.push(component);
  }
  return result;
}

/** Presentation-only source-lane queues. This is not a traffic-flow simulation:
 * it changes no route, presence, passenger, population or scientific state.
 * One retained instance belongs to one Scene; reset on a seek/dataset change.
 * Source paths and exact directed segment equality provide lane identity. No
 * nearest-road joins, lane creation, lateral displacement, or retained ghosts.
 */
export class LaneTraffic {
  private states = new Map<string, State>();
  private time: number | null = null;
  private sourceReanchors=0;
  private sourceRefreshes=0;
  private admissionOverflows=0;
  private followingOverflows=0;
  private readonly junctions = new JunctionTraffic();
  private readonly opposing = new OpposingLaneReservations();
  private junctionClearance: ((east:number,south:number,radius:number)=>boolean)|undefined;
  readonly policy = Object.freeze({ representation: 'visual_synthesis', mode: 'retained_source_lane_following',
    centreHeadwayMeters: HEADWAY, bodyEnvelopeMeters: 6, bumperGapMeters: 2, speed: 'common_authored_lane_speed',
    membership: 'current_source_ids_only', traversal: 'once_and_ping_pong_source_corridors' });

  sync(inputs: readonly LaneTrafficVehicle[], options:{isPointClear?:(east:number,south:number,radius:number)=>boolean}={}): void {
    if (inputs.length > 4096 || new Set(inputs.map(i => i.id)).size !== inputs.length) throw Error('Invalid traffic actor inventory');
    this.sourceRefreshes++;
    const next = new Map<string, State>();
    for (const input of inputs) {
      if (!input.id || !input.routeKey || ![input.sourceDistance, input.sourceTime, input.sourceSpeed, input.laneSpeed].every(Number.isFinite)
        || input.sourceSpeed < 0 || input.sourceSpeed > 60 || input.laneSpeed < 0 || input.laneSpeed > 60) throw Error('Invalid source traffic motion');
      const path = compilePath(input.path),reversePath=input.traversal==='ping_pong'?compilePath([...input.path].reverse()):path, old = this.states.get(input.id);
      const phase=old?.input.sourcePhase;
      const phaseTime=phase?phase.distance+phase.speed*(input.sourceTime-old!.input.sourceTime):0;
      const expectedPhase=phase?(old!.input.traversal==='ping_pong'?modulo(phaseTime,phase.length):Math.max(0,Math.min(phase.length,phaseTime))):old?sourceAt(old,input.sourceTime):0;
      const sourceContinuous = old && Math.abs((input.sourcePhase?.distance??input.sourceDistance)-expectedPhase) <= .25;
      if (old && old.input.routeKey === input.routeKey && old.basePath.key === path.key && old.input.singleLaneKey===input.singleLaneKey && sourceContinuous) {
        next.set(input.id, { ...old, input,basePath:path,reversePath,path:old.reversed?reversePath:path });
      } else {
        if(old)this.sourceReanchors++;
        const state: State = { input, path,basePath:path,reversePath,reversed:false, distance: 0, fresh: true, entered: false, speed: input.laneSpeed, junctionFresh:true,junctionBlocked:false };
        sourcePosition(state,this.time??input.sourceTime);next.set(input.id, state);
      }
    }
    this.states = next;
    this.junctionClearance=options.isPointClear;
    this.syncJunctions(this.time??inputs[0]?.sourceTime??0);
  }

  reset(): void {
    this.time = null;
    this.junctions.clear();
    this.opposing.clear();
    for (const state of this.states.values()) { state.fresh = true; state.entered = false; state.junctionFresh=true;state.junctionBlocked=false; }
  }

  private syncJunctions(time:number):void {
    const paths=new Map<string,JunctionPath>(),opposingPaths=new Map<string,OpposingLanePath>();
    for(const state of this.states.values())for(const path of new Set([state.basePath,state.reversePath])){
      const key=junctionKey(state,path);
      if(vehicle(state)&&state.input.singleLaneKey)opposingPaths.set(key,{key,points:path.points});
      paths.set(key,{key,kind:state.input.kind??'vehicle',points:path.points,atGrade:state.input.atGrade,
        maxSpeedMetersPerSecond:Math.max(paths.get(key)?.maxSpeedMetersPerSecond??0,state.input.laneSpeed),turnaround:state.input.traversal==='ping_pong',
        sourceCorridorKey:state.input.sourceCorridorKey,
        roadHalfWidthMeters:state.input.roadHalfWidthMeters,
        signalOffsetMeters:path===state.reversePath&&path!==state.basePath?state.input.reverseSignalOffsetMeters??state.input.signalOffsetMeters:state.input.signalOffsetMeters});
    }
    this.junctions.sync([...paths.values()],time,this.junctionClearance);
    this.opposing.sync([...opposingPaths.values()]);
  }

  readSignals(){const result=this.junctions.readSignals(),opposing=this.opposing.diagnostics;
    return {...result,diagnostics:{...result.diagnostics,opposingSections:opposing.sections,opposingPairChecks:opposing.pairChecks,
      overflow:result.diagnostics.overflow+opposing.overflow,overflowReasons:[...result.diagnostics.overflowReasons,...(opposing.overflow?['opposing_sections']:[])]}};}

  /** Bounded presentation evidence; carries no passengers or population records. */
  readProbe(ids:readonly string[]=[]){
    return this.buildProbe(ids,64);
  }
  /** Worker DEV capture only; one scan pins every current ID to its displayed frame. */
  readProbeAllForDevelopment(){
    return this.buildProbe([],4096);
  }
  private buildProbe(ids:readonly string[],rowLimit:number){
    const selected=ids.length?new Set(ids.slice(0,64)):null;
    const rows=[...this.states.values()].filter(state=>!selected||selected.has(state.input.id)).map(state=>{
      const at=location(state.path,state.distance);
      return {id:state.input.id,kind:state.input.kind??'vehicle',routeKey:state.input.routeKey,laneKey:at.key,laneInterval:[at.stationStart,at.stationEnd],
        distance:state.distance,station:at.station,point:at.point,visible:active(state),traversal:state.input.traversal??'once',singleLaneKey:state.input.singleLaneKey,sourceTime:state.input.sourceTime,
        sourceDistance:state.input.sourceDistance,sourceSpeed:state.input.sourceSpeed,laneSpeed:state.input.laneSpeed,presentationSpeed:state.speed};
    });
    const values=[...this.states.values()];
    return {policy:this.policy,time:this.time,managedVehicles:values.filter(vehicle).length,managedPedestrians:values.filter(state=>!vehicle(state)).length,
      sourceReanchors:this.sourceReanchors,sourceRefreshes:this.sourceRefreshes,
      admissionOverflows:this.admissionOverflows,
      followingOverflows:this.followingOverflows,
      opposingLaneSections:this.opposing.diagnostics.sections,opposingLaneOverflows:this.opposing.diagnostics.overflow,
      vehicles:rows.filter(row=>row.kind==='vehicle').slice(0,rowLimit),pedestrians:rows.filter(row=>row.kind==='pedestrian').slice(0,rowLimit)};
  }

  sampleWindow(time: number, interval = .2): { previous: ReadonlyMap<string, LaneTrafficSample>; next: ReadonlyMap<string, LaneTrafficSample> } {
    if (!Number.isFinite(time) || !Number.isFinite(interval) || interval < 0 || interval > 2) throw Error('Invalid traffic presentation time');
    // Seek is an explicit re-anchor, never a multi-second interpolation shortcut.
    if (this.time === null || time < this.time || time - this.time > 30) {
      for (const state of this.states.values()) { sourcePosition(state,time);state.fresh = true; state.entered = false; state.junctionFresh=true;state.junctionBlocked=false; }
      this.time = time;
      this.syncJunctions(time);
    }
    this.admit(this.states,time,true);
    this.advance(this.states, time - this.time,this.time,true); this.time = time;
    this.junctionCaps(this.states,new Map([...this.states.values()].map(state=>[state,state.distance])),time,true);
    const previous = this.snapshot(this.states), predicted = new Map([...this.states].map(([id, state]) => [id, { ...state }]));
    this.advance(predicted, interval,time,false);
    const next=new Map([...this.snapshot(predicted)].map(([id,sample])=>[id,
      previous.get(id)?.visible===false?{...sample,visible:false}:sample]));
    // Visibility is interpolated too. Releasing an entrant inside prediction
    // crossfades it through a departing body at their common source endpoint.
    // Admit its pixels only on a current sample after the old occupant is gone.
    return { previous, next };
  }

  private admitFresh(states: Map<string, State>): void {
    const occupied = [...states.values()].filter(state => vehicle(state)&&!state.fresh && active(state));
    const authorities=new Map<string,string>();
    for(const state of occupied)if(state.input.singleLaneKey&&!authorities.has(state.input.singleLaneKey))authorities.set(state.input.singleLaneKey,state.path.key);
    const fresh = [...states.values()].filter(state => state.fresh || !state.entered)
      .sort((a, b) => b.distance - a.distance || a.input.id.localeCompare(b.input.id));
    for (const state of fresh) {
      if(state.junctionBlocked){state.entered=false;state.fresh=false;continue;}
      if(!vehicle(state)){state.entered=true;state.fresh=false;continue;}
      const shared=state.input.singleLaneKey;
      if(shared){
        if(!authorities.has(shared))authorities.set(shared,state.path.key);
        if(authorities.get(shared)!==state.path.key){state.distance=0;state.entered=false;state.fresh=false;continue;}
      }
      let target = state.distance;
      // Only the entrant yields. A late source member must never move an already
      // displayed car backwards. No space at the source start means wait hidden.
      for (let pass = 0; pass <= occupied.length; pass++) {
        let limit = target;
        const here = location(state.path, target);
        for (const other of occupied) {
          const there = location(other.path, other.distance);
          if (state.path.key === other.path.key) {
            if (Math.abs(target - other.distance) < HEADWAY || Math.hypot(here.point[0] - there.point[0], here.point[1] - there.point[1]) < HEADWAY) {
              const cap=other.distance-HEADWAY;
              limit=Math.min(limit,cap<0?cap:safeBehind(state.path,there.point,0,cap));
            }
          } else if (sameLane(here,there) && Math.abs(here.station - there.station) < HEADWAY) limit = Math.min(limit, here.start + there.station-here.stationStart - HEADWAY);
        }
        if (limit === target || limit < 0) { target = limit; break; }
        target = limit;
      }
      state.distance = Math.max(0, target); state.entered = target >= 0; state.fresh = false;
      if (active(state)) occupied.push(state);
    }
  }

  private junctionCaps(states:Map<string,State>,desired:Map<State,number>,time:number,record:boolean){
    const actors=[...states.values()].map(state=>({id:state.input.id,pathKey:junctionKey(state),distance:state.distance,
      desired:desired.get(state)!,fresh:state.junctionFresh,entered:active(state)||state.fresh||state.junctionBlocked}));
    const junction=this.junctions.constrain(actors,time,record);
    return this.opposing.constrain(actors.map(actor=>({...actor,desired:junction.get(actor.id)!.distance,entered:junction.get(actor.id)!.visible})));
  }
  private admitJunctionFresh(states:Map<string,State>,time:number,record:boolean):void{
    const caps=this.junctionCaps(states,new Map([...states.values()].map(state=>[state,state.distance])),time,record);
    for(const state of states.values())if(state.junctionFresh||state.junctionBlocked){const cap=caps.get(state.input.id)!;
      state.distance=cap.distance;state.junctionBlocked=!cap.visible;state.junctionFresh=!cap.visible;
    }
  }

  private admit(states:Map<string,State>,time:number,record:boolean):void{
    const entrants=[...states.values()].filter(state=>state.fresh||!state.entered||state.junctionFresh||state.junctionBlocked);
    if(!entrants.length)return;
    // Either barrier can move a NEW actor backwards into the other's domain.
    // Keep entrant priority until both constraints agree on the same position;
    // existing actors never become fresh and never move backwards here.
    for(let pass=0;pass<Math.min(64,entrants.length+4);pass++){
      const before=entrants.map(state=>({distance:state.distance,entered:state.entered}));
      for(const state of entrants){state.fresh=true;state.junctionFresh=true;}
      this.admitJunctionFresh(states,time,record);
      this.admitFresh(states);
      if(entrants.every((state,index)=>Math.abs(state.distance-before[index]!.distance)<1e-7&&state.entered===before[index]!.entered)){
        for(const state of entrants){state.fresh=false;state.junctionFresh=state.junctionBlocked;}
        return;
      }
    }
    // An unresolved bounded admission chain preserves membership and waits for
    // the next sample rather than publishing an unchecked overlapping position.
    for(const state of entrants){state.entered=false;state.fresh=false;state.junctionFresh=true;state.junctionBlocked=true;}
    if(record)this.admissionOverflows++;
  }

  private advance(states: Map<string, State>, elapsed: number,startTime:number,record:boolean): void {
    const steps = Math.ceil(elapsed / .1), dt = steps ? elapsed / steps : 0;
    // A linearly interpolated window may not anticipate a future green or the
    // future departure of an occupied crossing. Freeze current stop permissions
    // for this whole window; a newly safe approach starts on the next sample.
    const potential=new Map([...states.values()].map(state=>[state,Math.min(state.path.length,state.distance+state.input.laneSpeed*elapsed)]));
    const currentCaps=this.junctionCaps(states,potential,startTime,false);
    const endingCaps=this.junctionCaps(states,potential,startTime+elapsed,false);
    const frozenStops=new Map([...states.values()].flatMap(state=>{
      const first=currentCaps.get(state.input.id)!,last=endingCaps.get(state.input.id)!;
      const cap={distance:Math.min(first.distance,last.distance),visible:first.visible&&last.visible};
      return cap.distance<potential.get(state)!-1e-7||!cap.visible?[[state,{distance:cap.distance,key:state.path.key}] as const]:[];
    }));
    for (let step = 0; step < steps; step++) {
      this.admit(states,startTime,record);
      const cars=[...states.values()].filter(vehicle);
      const whole = groups(cars, state => state.path.key);
      const shared = sharedGroups(cars);
      for (const state of states.values()) state.speed = state.input.laneSpeed;
      for (const collection of [[...whole.values()], shared]) for (const group of collection) {
        const speed = Math.min(...group.map(state => state.speed)); for (const state of group) state.speed = speed;
      }
      const desired = new Map([...states.values()].map(state => [state, state.entered ? Math.min(state.path.length, state.distance + state.speed * dt) : 0]));
      const junctionCaps=this.junctionCaps(states,desired,startTime,record);
      for(const state of states.values()){
        const stop=frozenStops.get(state);
        desired.set(state,Math.min(junctionCaps.get(state.input.id)!.distance,stop?.key===state.path.key?stop.distance:Infinity));
      }
      let followingSettled=false;
      for(let pass=0;pass<64;pass++){
      const beforeFollowing=cars.map(state=>desired.get(state)!);
      for (const group of whole.values()) {
        group.sort((a, b) => b.distance - a.distance || a.input.id.localeCompare(b.input.id));
        for (let i = 1; i < group.length; i++) {
          const leader = group[i - 1]!, follower = group[i]!, lead = desired.get(leader)!;
          if (lead < leader.path.length - 1e-7) {
            const maximum=Math.max(follower.distance,Math.min(desired.get(follower)!,lead-HEADWAY));
            desired.set(follower,safeBehind(follower.path,location(leader.path,lead).point,follower.distance,maximum));
          }
        }
      }
      // Exact coincident directed segments also occur under different source edge
      // IDs. Their queue constrains longitudinal progress without changing paths.
      for (const group of sharedGroups(cars,desired)) {
        group.sort((a, b) => location(b.path, desired.get(b)!).station - location(a.path, desired.get(a)!).station || a.input.id.localeCompare(b.input.id));
        for (let i = 1; i < group.length; i++) {
          const leader = group[i - 1]!, follower = group[i]!, lead = desired.get(leader)!;
          if (lead >= leader.path.length - 1e-7) continue;
          const here = location(follower.path, desired.get(follower)!), there = location(leader.path, lead);
          desired.set(follower, Math.max(follower.distance, Math.min(desired.get(follower)!, here.start + there.station-here.stationStart - HEADWAY)));
        }
      }
      if(cars.every((state,index)=>Math.abs(desired.get(state)!-beforeFollowing[index]!)<1e-7)){followingSettled=true;break;}
      }
      if(!followingSettled){for(const state of cars)desired.set(state,state.distance);if(record)this.followingOverflows++;}
      let turned=false;
      for (const state of states.values()) {
        const distance=desired.get(state)!;
        if(state.input.traversal==='ping_pong'&&state.entered&&distance>=state.path.length-1e-8){
          const remainder=Math.max(0,state.distance+state.speed*dt-state.path.length);
          state.reversed=!state.reversed;state.path=state.reversed?state.reversePath:state.basePath;
          state.distance=remainder;state.fresh=true;state.entered=false;turned=true;
        }else state.distance=distance;
      }
      // A lone actor turns continuously. A conflicting narrow-lane direction
      // waits at this SAME source endpoint until the current direction drains.
      if(turned)this.admit(states,startTime,record);
    }
  }

  private snapshot(states: Map<string, State>): ReadonlyMap<string, LaneTrafficSample> {
    return new Map([...states].map(([id, state]) => { const at = location(state.path, state.distance); return [id,
      { distance: state.distance, length: state.path.length, point: at.point, heading: at.heading, visible: active(state), speed: state.speed,traversal:state.input.traversal??'once' }]; }));
  }
}
