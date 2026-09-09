import { GAME_HEADING_POLICY } from './gameActorHeading';
type Point = readonly [number, number];
export type JunctionKind = 'vehicle' | 'pedestrian';
export interface JunctionPath {
  readonly key: string;
  readonly kind: JunctionKind;
  readonly points: readonly Point[];
  readonly atGrade?: boolean;
  readonly roadHalfWidthMeters?: number;
  /** Distance from this displayed corridor to the verified right roadside. */
  readonly signalOffsetMeters?: number;
  readonly maxSpeedMetersPerSecond?: number;
  readonly turnaround?: boolean;
  /** Exact verified constituent road IDs; geometry alone never proves grade identity. */
  readonly sourceCorridorKey?:string;
}
export interface JunctionActor {
  readonly id: string; readonly pathKey: string; readonly distance: number;
  readonly desired: number; readonly fresh: boolean; readonly entered: boolean;
}
export interface JunctionCap { distance: number; visible: boolean }
export interface JunctionSignalApproach {
  id: string; kind: JunctionKind; stopPoint: Point; heading: number;
  aspect: 'red' | 'amber' | 'green'; waiting: number; occupied: number;
  signalPoint: Point | null; roadHalfWidthMeters?: number;
}
export interface JunctionSignal {
  id: string; point: Point; radiusMeters: number;
  phase: 'vehicle' | 'pedestrian' | 'clearance'; heldForOccupancy: boolean;
  approaches: JunctionSignalApproach[];
}
export const JUNCTION_LIMITS = Object.freeze({ maxPaths: 2048, maxPathPoints: 65536, maxSegments: 8192,
  maxGridEntries: 65536, maxPairChecks: 250000, maxJunctions: 256, maxApproaches: 32 });
type Limits = { -readonly [K in keyof typeof JUNCTION_LIMITS]: number };
interface Path extends JunctionPath { distances: number[]; length: number; seen: number; corridorKey:string; reversed:boolean }
interface Ref { path: Path; index: number }
interface Segment { a: Point; b: Point; kind: JunctionKind; refs: Ref[]; turning?:boolean }
interface Crossing { point: Point; radius: number; longitudinal:boolean; corridorKey?:string; refs: Map<string, { path: Path; station: number; heading: number; radius:number }> }
interface Approach { id: string; pathKey: string; kind: JunctionKind; station: number; entry: number; exit: number;
  heading: number; axis: number; stopPoint: Point; signalPoint: Point | null; roadHalfWidthMeters?: number }
interface Node { id: string; point: Point; radius: number; approaches: Approach[]; longitudinal:boolean }
const physicalApproaches=(node:Node)=>[...new Map(node.approaches.map(approach=>[approach.id,approach])).values()];
const EPS = 1e-7, GRID = 64, RETAIN_SECONDS = 120;
const TURNING_RADIUS = Math.hypot(2.25,1), HEADING_SAMPLE_HORIZON=.25;
const pointKey = (p: Point) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
const hash = (value: string) => { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return (h >>> 0).toString(16); };
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
const minus = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
function supportingLineKey(a:Point,b:Point):string{
  let dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);dx/=length;dz/=length;
  if(dx<0||Math.abs(dx)<1e-8&&dz<0){dx=-dx;dz=-dz;}
  return `${Math.round(Math.atan2(dz,dx)*1e8)}:${Math.round((-dz*a[0]+dx*a[1])*100000)}`;
}
function physicalApproachKey(path:Path,station:number,heading:number):string{
  const radians=heading*Math.PI/180,point=pointAt(path,station),dx=Math.sin(radians),dz=-Math.cos(radians);
  return `${path.kind}:${Math.round(heading*1e6)}:${Math.round((-dz*point[0]+dx*point[1])*10000)}`;
}
function phaseAt(time: number) {
  const phase = ((time % 30) + 30) % 30;
  return phase < 8 ? { kind: 'vehicle' as const, axis: 0 } : phase < 10 ? { kind: 'clearance' as const, axis: 0 }
    : phase < 18 ? { kind: 'vehicle' as const, axis: 1 } : phase < 20 ? { kind: 'clearance' as const, axis: 1 }
      : phase < 28 ? { kind: 'pedestrian' as const, axis: -1 } : { kind: 'clearance' as const, axis: -1 };
}
function pointAt(path: Path, distance: number): Point {
  distance = Math.max(0, Math.min(path.length, distance));
  let low = 1, high = path.points.length - 1;
  while (low < high) { const middle = (low + high) >>> 1; if (path.distances[middle]! < distance) low = middle + 1; else high = middle; }
  const a = path.points[low - 1]!, b = path.points[low]!, t = (distance - path.distances[low - 1]!) / (path.distances[low]! - path.distances[low - 1]!);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
function bodySweepsOverlap(a:Segment,b:Segment):boolean{
  const basis=(segment:Segment)=>{const d=minus(segment.b,segment.a),length=Math.hypot(...d),forward:Point=[d[0]/length,d[1]/length];
    return {center:[(segment.a[0]+segment.b[0])/2,(segment.a[1]+segment.b[1])/2] as Point,forward,
      side:[-forward[1],forward[0]] as Point,halfLength:length/2+(segment.turning?TURNING_RADIUS:segment.kind==='vehicle'?2.25:.35),halfWidth:segment.turning?TURNING_RADIUS:segment.kind==='vehicle'?1:.35};};
  const x=basis(a),y=basis(b),delta=minus(x.center,y.center),dot=(p:Point,q:Point)=>p[0]*q[0]+p[1]*q[1];
  return [x.forward,x.side,y.forward,y.side].every(axis=>Math.abs(dot(delta,axis))<=
    x.halfLength*Math.abs(dot(x.forward,axis))+x.halfWidth*Math.abs(dot(x.side,axis))+
    y.halfLength*Math.abs(dot(y.forward,axis))+y.halfWidth*Math.abs(dot(y.side,axis))+.05);
}
function closestPair(a:Segment,b:Segment):Point{
  const project=(p:Point,segment:Segment):Point=>{const d=minus(segment.b,segment.a),squared=d[0]*d[0]+d[1]*d[1];
    const t=Math.max(0,Math.min(1,((p[0]-segment.a[0])*d[0]+(p[1]-segment.a[1])*d[1])/squared));return [segment.a[0]+t*d[0],segment.a[1]+t*d[1]];};
  const pairs=[[a.a,project(a.a,b)],[a.b,project(a.b,b)],[project(b.a,a),b.a],[project(b.b,a),b.b]] as const;
  const pair=[...pairs].sort((x,y)=>Math.hypot(...minus(x[0],x[1]))-Math.hypot(...minus(y[0],y[1])))[0]!;
  return [(pair[0][0]+pair[1][0])/2,(pair[0][1]+pair[1][1])/2];
}
function intersection(a: Segment, b: Segment): { point: Point; radius: number; longitudinal:boolean; corridorKey?:string } | null {
  if(a.kind==='pedestrian'&&b.kind==='pedestrian')return null;
  const r = minus(a.b, a.a), s = minus(b.b, b.a), delta = minus(b.a, a.a), denominator = cross(r, s);
  if (Math.abs(denominator) > EPS) {
    const t = cross(delta, s) / denominator, u = cross(delta, r) / denominator;
    if(t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS)
      return { point: [a.a[0] + t * r[0], a.a[1] + t * r[1]], radius: 2, longitudinal:false };
    // Offsetting lanes can separate centreline endpoints while the rendered
    // 4.5x2m vehicle and .35m pedestrian body sweeps still overlap.
    return bodySweepsOverlap(a,b)?{point:closestPair(a,b),radius:2,longitudinal:false}:null;
  }
  // Cars and pedestrians on an undisplaced common source corridor are an
  // explicit longitudinal conflict too. They cannot silently pass through.
  if (a.kind === b.kind) return null;
  if(Math.abs(cross(delta,r))>EPS&&!bodySweepsOverlap(a,b))return null;
  const length = Math.hypot(...r), squared = length * length;
  const t0 = (delta[0] * r[0] + delta[1] * r[1]) / squared;
  const d1 = minus(b.b, a.a), t1 = (d1[0] * r[0] + d1[1] * r[1]) / squared;
  const start = Math.max(0, Math.min(t0, t1)), end = Math.min(1, Math.max(t0, t1));
  if (end <= start + EPS) return bodySweepsOverlap(a,b)?{point:closestPair(a,b),radius:2,longitudinal:false}:null;
  const car=a.kind==='vehicle'?a:b;
  return { point: [a.a[0] + (start + end) / 2 * r[0], a.a[1] + (start + end) / 2 * r[1]], radius: (end - start) * length / 2 + 2,longitudinal:true,corridorKey:supportingLineKey(car.a,car.b) };
}

function turningIntervals(path:Path):readonly (readonly[number,number])[]{
  if(path.kind!=='vehicle'||!path.maxSpeedMetersPerSecond)return[];
  const speed=path.maxSpeedMetersPerSecond,intervals:[number,number][]=[];
  const add=(station:number,angle:number)=>{
    const duration=Math.max(GAME_HEADING_POLICY.minimumDurationSeconds,1.5*angle/GAME_HEADING_POLICY.maxRadiansPerSecond);
    intervals.push([Math.max(0,station-speed*HEADING_SAMPLE_HORIZON),Math.min(path.length,station+speed*(duration+HEADING_SAMPLE_HORIZON))]);
  };
  if(path.turnaround)add(0,Math.PI);
  for(let i=1;i<path.points.length-1;i++){
    const a=minus(path.points[i]!,path.points[i-1]!),b=minus(path.points[i+1]!,path.points[i]!);
    const cosine=Math.max(-1,Math.min(1,(a[0]*b[0]+a[1]*b[1])/(Math.hypot(...a)*Math.hypot(...b)))),angle=Math.acos(cosine);
    if(angle>.01)add(path.distances[i]!,angle);
  }
  return intervals;
}

/** Visual signal phases, exact source-segment conflicts, and occupied-zone
 * reservations. No source route, ID, presence, passenger or population mutation.
 * Geometry remains for 120 presentation seconds through membership churn;
 * clocks are derived from presentation time and never restart on source refresh.
 */
export class JunctionTraffic {
  private readonly limits: Limits;
  private paths = new Map<string, Path>();
  private nodes: Node[] = [];
  private signals: JunctionSignal[] = [];
  private lastTime = 0;
  private clearPoint: ((east: number, south: number, radius: number) => boolean) | undefined;
  private diagnostics = { paths: 0, segments: 0, gridEntries: 0, pairChecks: 0, junctions: 0,
    overflow: 0, overflowReasons:[] as string[],mergeRefChecks:0, omittedProps: 0, assumedAtGradePaths: 0, pathPoints:0,propClearanceChecks:0,freshAdmissionPasses:0,longitudinalReservations:0,retainedSeconds: RETAIN_SECONDS };
  readonly policy = Object.freeze({ representation: 'visual_synthesis', mode: 'source_junction_reservations',
    timing: '8s_axis_0_2s_clearance_8s_axis_1_2s_clearance_8s_pedestrian_2s_clearance',
    surveyedTiming: false, clearance: 'occupied_conflict_zone_must_drain', sourceMembership: 'current_ids_only' });

  constructor(limits: Partial<Limits> = {}) {
    this.limits = { ...JUNCTION_LIMITS };
    for (const key of Object.keys(limits) as (keyof Limits)[]) {
      const value = limits[key]; if (!Number.isSafeInteger(value) || value! < 1) throw Error('Invalid junction limit');
      this.limits[key] = Math.min(this.limits[key], value!);
    }
  }
  clear(): void { this.paths.clear(); this.nodes = []; this.signals = []; this.diagnostics.overflow = 0; }

  sync(inputs: readonly JunctionPath[], time: number, isPointClear?: (east: number, south: number, radius: number) => boolean): void {
    if (!Number.isFinite(time) || inputs.length > 4096) throw Error('Invalid junction source inventory');
    this.clearPoint = isPointClear; this.lastTime = time;
    for (const [key, path] of this.paths) if (time < path.seen || time - path.seen > RETAIN_SECONDS) this.paths.delete(key);
    let overflow = 0,retainedPoints=[...this.paths.values()].reduce((sum,path)=>sum+path.points.length,0);
    const overflowReasons=new Set<string>(),failBound=(reason:string)=>{overflow++;overflowReasons.add(reason);};
    for (const input of inputs) {
      if (!input.key || input.key.length > 500000 || !['vehicle', 'pedestrian'].includes(input.kind) || input.points.length < 2
        || input.points.length > 8192 || input.points.some(p => p.length !== 2 || p.some(v => !Number.isFinite(v) || Math.abs(v) > 1e6))
        || input.signalOffsetMeters !== undefined && (!Number.isFinite(input.signalOffsetMeters) || Math.abs(input.signalOffsetMeters) > 40)
        || input.maxSpeedMetersPerSecond!==undefined&&(!Number.isFinite(input.maxSpeedMetersPerSecond)||input.maxSpeedMetersPerSecond<0||input.maxSpeedMetersPerSecond>60)
        || input.sourceCorridorKey!==undefined&&(!input.sourceCorridorKey||input.sourceCorridorKey.length>65536)
        || input.roadHalfWidthMeters !== undefined && (!Number.isFinite(input.roadHalfWidthMeters) || input.roadHalfWidthMeters < .15 || input.roadHalfWidthMeters > 20)) throw Error('Invalid junction source geometry');
      const old = this.paths.get(input.key);
      if (old) {
        if (old.kind !== input.kind || old.points.length !== input.points.length
          || old.points.some((point, index) => point.some((value, axis) => value !== input.points[index]![axis]))) {
          throw Error('Retained junction path key changed geometry');
        }
        // Verified source road metadata may arrive after the actor inventory.
        // Preserve geometry and phase continuity while allowing roadside props
        // and grade provenance to upgrade on that same retained route.
        this.paths.set(input.key, { ...old, atGrade: input.atGrade,
          roadHalfWidthMeters: input.roadHalfWidthMeters,
          signalOffsetMeters: input.signalOffsetMeters,maxSpeedMetersPerSecond:input.maxSpeedMetersPerSecond,turnaround:input.turnaround,sourceCorridorKey:input.sourceCorridorKey, seen: time });
        continue;
      }
      if (this.paths.size >= this.limits.maxPaths || retainedPoints+input.points.length>this.limits.maxPathPoints) { failBound('source_geometry'); continue; }
      const distances = [0];
      for (let i = 1; i < input.points.length; i++) {
        const distance = Math.hypot(...minus(input.points[i]!, input.points[i - 1]!));
        if (distance < 1e-5) throw Error('Degenerate junction source segment');
        distances.push(distances.at(-1)! + distance);
      }
      const forward=input.points.map(pointKey).join(';'),reverse=[...input.points].reverse().map(pointKey).join(';');
      this.paths.set(input.key, { ...input, points: input.points.map(p => [p[0], p[1]] as Point), distances, length: distances.at(-1)!, seen: time,
        corridorKey:forward<reverse?forward:reverse,reversed:forward>reverse });
      retainedPoints+=input.points.length;
    }
    const segments: Segment[] = [], segmentByKey = new Map<string, Segment>();
    let points = 0;
    for (const path of this.paths.values()) {
      points += path.points.length; if (points > this.limits.maxPathPoints) { failBound('source_points'); break; }
      const turns=turningIntervals(path);
      for (let i = 1; i < path.points.length; i++) {
        const start=path.distances[i-1]!,end=path.distances[i]!;
        const splits=[start,...turns.flatMap(interval=>interval.filter(value=>value>start+EPS&&value<end-EPS)),end].sort((a,b)=>a-b);
        for(let part=1;part<splits.length;part++){
        if(splits[part]!-splits[part-1]!<EPS)continue;
        const a = pointAt(path,splits[part-1]!), b = pointAt(path,splits[part]!), keys = [pointKey(a), pointKey(b)].sort();
        const middle=(splits[part-1]!+splits[part]!)/2,turning=turns.some(interval=>middle>=interval[0]&&middle<=interval[1]);
        // Geometry aliases with unknown metadata cannot invalidate a verified
        // bridge pair, or lend that pair's grade evidence to another source.
        const gradeGroup=path.atGrade===false?`separated:${path.sourceCorridorKey??path.key}`:'ground';
        const key = `${path.kind}:${turning}:${gradeGroup}:${keys[0]}:${keys[1]}`;
        let segment = segmentByKey.get(key);
        if (!segment) {
          if (segments.length >= this.limits.maxSegments) { failBound('segments'); break; }
          segment = { a, b, kind: path.kind, refs: [],turning }; segmentByKey.set(key, segment); segments.push(segment);
        }
        segment.refs.push({ path, index: i });
        }
        if(overflow)break;
      }
      if (overflow) break;
    }
    const grid = new Map<string, number[]>(); let gridEntries = 0;
    for (let i = 0; i < segments.length && !overflow; i++) {
      const { a, b } = segments[i]!;
      const west = Math.floor((Math.min(a[0], b[0])-3) / GRID), east = Math.floor((Math.max(a[0], b[0])+3) / GRID);
      const north = Math.floor((Math.min(a[1], b[1])-3) / GRID), south = Math.floor((Math.max(a[1], b[1])+3) / GRID);
      if (gridEntries + (east - west + 1) * (south - north + 1) > this.limits.maxGridEntries) { failBound('spatial_grid'); break; }
      for (let x = west; x <= east; x++) for (let z = north; z <= south; z++) {
        const key = `${x}:${z}`, entries = grid.get(key) ?? []; entries.push(i); grid.set(key, entries); gridEntries++;
      }
    }
    const checked = new Set<string>(), crossings = new Map<string, Crossing>(); let pairChecks = 0;
    const crossingsByGroup=new Map<string,{key:string;node:Crossing}[]>();
    let mergeRefChecks=0;
    const intervalCache=new WeakMap<Crossing,Map<string,[number,number][]>>();
    const intervals=(crossing:Crossing)=>{
      const cached=intervalCache.get(crossing);if(cached)return cached;
      const grouped=new Map<string,[number,number][]>();
      for(const ref of crossing.refs.values()){
        const margin=ref.path.kind==='vehicle'?5:1.2,rows=grouped.get(ref.path.key)??[];
        rows.push([ref.station-ref.radius-margin,ref.station+ref.radius+margin]);grouped.set(ref.path.key,rows);
      }
      for(const[key,rows]of grouped){
        rows.sort((a,b)=>a[0]-b[0]);const union:[number,number][]=[];
        for(const row of rows){const last=union.at(-1);if(last&&row[0]<=last[1])last[1]=Math.max(last[1],row[1]);else union.push([...row]);}
        grouped.set(key,union);
      }
      intervalCache.set(crossing,grouped);return grouped;
    };
    const overlaps=(a:Crossing,b:Crossing)=>{
      const left=intervals(a),right=intervals(b);
      for(const[key,x]of left){const y=right.get(key);if(!y)continue;
        let i=0,j=0;while(i<x.length&&j<y.length){
          if(mergeRefChecks>=this.limits.maxPairChecks){if(!overflowReasons.has('merge_checks'))failBound('merge_checks');return false;}mergeRefChecks++;
          if(x[i]![0]<=y[j]![1]&&y[j]![0]<=x[i]![1])return true;
          if(x[i]![1]<y[j]![1])i++;else j++;
        }
      }
      return false;
    };
    const compactCrossings=(values:Iterable<Crossing>)=>{
      const clusters:Crossing[]=[];
      for(const crossing of values){
        const combined:Crossing={...crossing,refs:new Map(crossing.refs)};
        let merged=true;
        while(merged){merged=false;
          for(let i=clusters.length-1;i>=0;i--){const cluster=clusters[i]!;
            if(combined.longitudinal!==cluster.longitudinal||combined.longitudinal&&combined.corridorKey!==cluster.corridorKey)continue;
            if(!overlaps(combined,cluster))continue;
            for(const[key,ref]of cluster.refs)combined.refs.set(key,ref);
            intervalCache.delete(combined);clusters.splice(i,1);merged=true;
          }
        }
        clusters.push(combined);
      }
      return clusters;
    };
    const compactBatchSize=this.limits.maxJunctions*2;
    let compactAt=compactBatchSize,compactSerial=0;
    for (const entries of grid.values()) {
      if (overflow) break;
      for (let i = 0; i < entries.length && !overflow; i++) for (let j = i + 1; j < entries.length; j++) {
        const left = entries[i]!, right = entries[j]!, pair = `${left}:${right}`;
        if (checked.has(pair)) continue;
        if (++pairChecks > this.limits.maxPairChecks) { failBound('segment_pairs'); break; }
        checked.add(pair);
        const a = segments[left]!, b = segments[right]!, hit = intersection(a, b); if (!hit) continue;
        // Consecutive pieces of a single corridor do not form a crossing alone.
        const canonicalIndex=(ref:Ref)=>ref.path.reversed?ref.path.points.length-ref.index:ref.index;
        const sameSourceSection=a.kind!==b.kind&&a.refs.every(x=>b.refs.every(y=>x.path.corridorKey===y.path.corridorKey&&Math.abs(canonicalIndex(x)-canonicalIndex(y))<=1));
        if([...a.refs,...b.refs].some(ref=>ref.path.atGrade===false)
          &&!(sameSourceSection&&a.refs.every(x=>b.refs.every(y=>Boolean(x.path.sourceCorridorKey)&&x.path.sourceCorridorKey===y.path.sourceCorridorKey))))continue;
        if (a.kind === b.kind && a.refs.every(x => b.refs.every(y => x.path.corridorKey === y.path.corridorKey && Math.abs(canonicalIndex(x) - canonicalIndex(y)) === 1))) continue;
        if(sameSourceSection){
          hit.longitudinal=true;hit.corridorKey=`source:${a.refs[0]!.path.corridorKey}`;
        }
        const key = `${hit.longitudinal?'corridor:'+hit.corridorKey+':'+Math.round(hit.radius*1000)+':':'junction:'}${pointKey(hit.point)}`, node:Crossing = (!hit.longitudinal?crossings.get(key):undefined) ?? { point: hit.point, radius: hit.radius,longitudinal:hit.longitudinal,corridorKey:hit.corridorKey, refs: new Map() };
        node.radius = Math.max(node.radius, hit.radius);
        for (const ref of [...a.refs, ...b.refs]) {
          const p = ref.path.points[ref.index - 1]!, q = ref.path.points[ref.index]!, dx = q[0] - p[0], dz = q[1] - p[1], length = Math.hypot(dx, dz);
          const along = ((hit.point[0] - p[0]) * dx + (hit.point[1] - p[1]) * dz) / length;
          const station = ref.path.distances[ref.index - 1]! + along;
          const heading = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
          node.refs.set(`${ref.path.key}:${Math.round(station * 1000)}`, { path: ref.path, station, heading,radius:hit.radius });
        }
        intervalCache.delete(node);
        if(hit.longitudinal){
          // Collapse repeated pieces of one longitudinal source corridor early;
          // keep these reservations separate from transverse local junctions.
          const group=hit.longitudinal?`corridor:${hit.corridorKey}`:'junction';
          const siblings=crossingsByGroup.get(group)??[];
          let merged=true;
          while(merged){merged=false;for(let i=siblings.length-1;i>=0;i--){const old=siblings[i]!;
            if(!overlaps(node,old.node))continue;
            for(const[key,ref]of old.node.refs)node.refs.set(key,ref);
            intervalCache.delete(node);
            siblings.splice(i,1);crossings.delete(old.key);merged=true;
          }}
          siblings.push({key,node});crossingsByGroup.set(group,siblings);
        }
        crossings.set(key, node);
        if(crossings.size>=compactAt){
          // Compact local body-contact variants in bounded batches, not after
          // every pair. All source intervals survive; repeated full rescans
          // must not consume the merge budget during a cold inventory refresh.
          const compacted=compactCrossings(crossings.values());
          crossings.clear();crossingsByGroup.clear();
          for(const node of compacted){
            const key=`compacted:${compactSerial++}`;crossings.set(key,node);
            if(node.longitudinal){const group=`corridor:${node.corridorKey}`,siblings=crossingsByGroup.get(group)??[];
              siblings.push({key,node});crossingsByGroup.set(group,siblings);}
          }
          compactAt=crossings.size+compactBatchSize;
        }
        if (crossings.size > this.limits.maxJunctions * 4) { failBound('unmerged_crossings'); break; }
      }
    }
    // Join overlapping occupied intervals on real shared source paths. Point
    // distance alone leaves circular reservations between adjacent junctions.
    const clusters=compactCrossings(crossings.values());
    const previous = this.nodes;
    this.nodes = [];
    const usedNodeIds=new Set<string>();
    let propClearanceChecks=0;
    for (const cluster of clusters) {
      if (this.nodes.length >= this.limits.maxJunctions) { failBound('junctions'); break; }
      const byPath = new Map<string, typeof cluster.refs extends Map<string, infer T> ? T[] : never>();
      for (const ref of cluster.refs.values()) { const entries = byPath.get(ref.path.key) ?? []; entries.push(ref); byPath.set(ref.path.key, entries); }
      const physicalKeys=new Set([...byPath.values()].map(refs=>{const ref=refs.reduce((a,b)=>a.station<b.station?a:b);return physicalApproachKey(ref.path,ref.station,ref.heading);}));
      if (physicalKeys.size > this.limits.maxApproaches) { failBound('physical_approaches'); continue; }
      // A retained identifier belongs to one physical node. Nearby clusters on
      // a common route must not all inherit the first old node's identity.
      const old = previous.filter(node => !usedNodeIds.has(node.id)&&node.longitudinal===cluster.longitudinal
        &&Math.hypot(...minus(node.point, cluster.point)) <= 12 && node.approaches.some(a => byPath.has(a.pathKey)))
        .sort((a,b)=>Math.hypot(...minus(a.point,cluster.point))-Math.hypot(...minus(b.point,cluster.point))||a.id.localeCompare(b.id))[0];
      const radius=Math.max(...[...cluster.refs.values()].map(ref=>Math.hypot(...minus(pointAt(ref.path,ref.station),cluster.point))+ref.radius));
      const baseId=old?.id??`junction-${hash(`${cluster.longitudinal}:${cluster.corridorKey??''}:${pointKey(cluster.point)}:${[...physicalKeys].sort().join(';')}`)}`;
      let id=baseId,suffix=1;while(usedNodeIds.has(id))id=`${baseId}-${suffix++}`;usedNodeIds.add(id);
      const node: Node = { id, point: cluster.point, radius, approaches: [],longitudinal:cluster.longitudinal };
      for (const refs of byPath.values()) {
        refs.sort((a, b) => a.station - b.station); const ref = refs[0]!, path = ref.path;
        const station = (refs[0]!.station + refs.at(-1)!.station) / 2;
        const margin=path.kind==='vehicle'?5:1.2;
        const entry=Math.min(...refs.map(ref=>ref.station-ref.radius-margin)),exit=Math.max(...refs.map(ref=>ref.station+ref.radius+margin));
        const stopPoint = pointAt(path, entry), radians = ref.heading * Math.PI / 180;
        let signalPoint: Point | null = null;
        if (!cluster.longitudinal&&path.atGrade === true && path.signalOffsetMeters !== undefined && entry >= 0 && this.clearPoint) {
          const candidate: Point = [stopPoint[0] + Math.cos(radians) * path.signalOffsetMeters, stopPoint[1] + Math.sin(radians) * path.signalOffsetMeters];
          let roadClear=true;
          for(const segment of segments){
            if(segment.kind!=='vehicle')continue;
            if(propClearanceChecks>=65536){roadClear=false;break;}propClearanceChecks++;
            const dx=segment.b[0]-segment.a[0],dz=segment.b[1]-segment.a[1],lengthSquared=dx*dx+dz*dz;
            const t=Math.max(0,Math.min(1,((candidate[0]-segment.a[0])*dx+(candidate[1]-segment.a[1])*dz)/lengthSquared));
            if(Math.hypot(candidate[0]-segment.a[0]-t*dx,candidate[1]-segment.a[1]-t*dz)<1.25){roadClear=false;break;}
          }
          if (roadClear&&this.clearPoint(candidate[0], candidate[1], .25)) signalPoint = candidate;
        }
        node.approaches.push({ id: `${node.id}:${hash(physicalApproachKey(path,ref.station,ref.heading))}`, pathKey: path.key, kind: path.kind, station, entry, exit,
          heading: ref.heading, axis: Math.abs(Math.sin(radians)) >= Math.abs(Math.cos(radians)) ? 0 : 1,
          stopPoint, signalPoint, roadHalfWidthMeters: path.roadHalfWidthMeters });
      }
      node.approaches.sort((a, b) => a.id.localeCompare(b.id)); this.nodes.push(node);
    }
    this.nodes.sort((a, b) => a.id.localeCompare(b.id));
    this.diagnostics = { paths: this.paths.size, segments: segments.length, gridEntries, pairChecks, junctions: this.nodes.length,
      overflow,overflowReasons:[...overflowReasons].sort(),mergeRefChecks, omittedProps: this.nodes.reduce((n, node) => n + physicalApproaches(node).filter(a => a.signalPoint === null).length, 0),
      assumedAtGradePaths: [...this.paths.values()].filter(path => path.atGrade === undefined).length,
      pathPoints:retainedPoints,propClearanceChecks,freshAdmissionPasses:0,longitudinalReservations:this.nodes.filter(node=>node.longitudinal).length,retainedSeconds: RETAIN_SECONDS };
    this.constrain([], time);
  }

  constrain(actors: readonly JunctionActor[], time: number, record = true, admissionPass = 0): Map<string, JunctionCap> {
    if (!Number.isFinite(time) || actors.length > 4096 || actors.some(actor => !actor.id || !actor.pathKey
      || !Number.isFinite(actor.distance) || !Number.isFinite(actor.desired) || actor.distance < 0 || actor.desired < 0)) throw Error('Invalid junction actor sample');
    const result = new Map(actors.map(actor => [actor.id, { distance: actor.desired, visible: actor.entered }]));
    if (this.diagnostics.overflow) {
      for (const actor of actors) result.set(actor.id, { distance: actor.distance, visible: actor.entered&&!actor.fresh });
      if(record){this.lastTime=time;this.signals=this.nodes.map(node=>({id:node.id,point:node.point,radiusMeters:node.radius,
        phase:'clearance',heldForOccupancy:false,approaches:physicalApproaches(node).map(approach=>({id:approach.id,kind:approach.kind,
          stopPoint:approach.stopPoint,heading:approach.heading,aspect:'red',waiting:0,occupied:0,
          signalPoint:approach.signalPoint,roadHalfWidthMeters:approach.roadHalfWidthMeters}))}));}
      return result;
    }
    const phase = phaseAt(time), byPath = new Map<string, JunctionActor[]>();
    for (const actor of actors) { const entries = byPath.get(actor.pathKey) ?? []; entries.push(actor); byPath.set(actor.pathKey, entries); }
    const signals: JunctionSignal[] = [];
    for (const node of this.nodes) {
      const visitors = node.approaches.flatMap(approach => (byPath.get(approach.pathKey) ?? []).map(actor => ({ actor, approach })));
      const occupied = visitors.filter(({ actor, approach }) => actor.entered && !actor.fresh && actor.distance > approach.entry + EPS && actor.distance < approach.exit - EPS);
      const permitted = (approach: Approach) => phase.kind === approach.kind && (approach.kind === 'pedestrian' || approach.axis === phase.axis);
      const compatible = (a: Approach, b: Approach) => a.kind === 'pedestrian' && b.kind === 'pedestrian' || a.id === b.id;
      const reservations = [...occupied];
      const counts = new Map(node.approaches.map(approach => [approach.id, { waiting: 0, occupied: occupied.filter(o => o.approach.id === approach.id).length }]));
      visitors.sort((a, b) => Number(a.actor.fresh) - Number(b.actor.fresh) || Number(permitted(b.approach)) - Number(permitted(a.approach))
        || b.actor.distance - a.actor.distance || a.actor.id.localeCompare(b.actor.id));
      for (const visitor of visitors) {
        const { actor, approach } = visitor, cap = result.get(actor.id)!;
        if (!actor.entered || actor.distance >= approach.exit - EPS
          || cap.distance <= approach.entry + EPS && actor.distance < approach.entry - .05) continue;
        if (occupied.some(item => item.actor.id === actor.id)) continue;
        const free = reservations.every(item => item.actor.id === actor.id || compatible(approach, item.approach));
        if (permitted(approach) && free) reservations.push(visitor);
        else {
          cap.distance = Math.min(cap.distance, actor.fresh ? Math.max(0, approach.entry) : Math.max(actor.distance, approach.entry));
          if (actor.fresh && approach.entry < 0) cap.visible = false;
          counts.get(approach.id)!.waiting++;
        }
      }
      const heldForOccupancy = occupied.some(item => !permitted(item.approach));
      signals.push({ id: node.id, point: node.point, radiusMeters: node.radius, phase: phase.kind, heldForOccupancy,
        approaches: physicalApproaches(node).map(approach => {
          const blocked = occupied.some(item => !compatible(approach, item.approach));
          return { id: approach.id, kind: approach.kind, stopPoint: approach.stopPoint, heading: approach.heading,
            aspect: phase.kind === 'clearance' && counts.get(approach.id)!.occupied ? 'amber' : permitted(approach) && !blocked ? 'green' : 'red',
            ...counts.get(approach.id)!, signalPoint: approach.signalPoint, roadHalfWidthMeters: approach.roadHalfWidthMeters };
        }) });
    }
    // A downstream stop can move a fresh entrant backwards into an upstream
    // occupied zone. Re-run only monotone fresh admission, never rewind an
    // incumbent. A bounded unresolved chain waits hidden at its source point.
    const readmit=actors.some(actor=>actor.fresh&&(result.get(actor.id)!.distance<actor.distance-EPS||actor.entered&&!result.get(actor.id)!.visible));
    if(readmit){
      if(admissionPass<Math.min(64,this.nodes.length+1))return this.constrain(actors.map(actor=>actor.fresh?
        {...actor,distance:result.get(actor.id)!.distance,desired:result.get(actor.id)!.distance,entered:result.get(actor.id)!.visible}:actor),time,record,admissionPass+1);
      for(const actor of actors)if(actor.fresh)result.get(actor.id)!.visible=false;
    }
    if (record) { this.lastTime = time; this.signals = signals;this.diagnostics.freshAdmissionPasses=admissionPass; }
    return result;
  }
  readSignals() { return { policy: this.policy, junctions: this.signals, diagnostics: { ...this.diagnostics }, time: this.lastTime }; }
}
