import { MercatorCoordinate } from 'maplibre-gl';
import type { LivingSceneMovementEntitySource } from '../living/sceneMovement';
import type { VisualEntity, WorldSceneMovementPayload } from '../types';
import type { GameOrigin } from './cameraAdapter';
import type { GameActorColumns } from './GameActors';
import type { LaneTraffic, LaneTrafficSample, LaneTrafficVehicle } from './laneTraffic';
import { resolveGameRoadWidth } from './gameRoadWidth';

type Point = [number,number,number];
type Road = { points: Point[]; distances: number[]; length: number };
type Binding = { road:Road; progress:number; speed:number; reverse:boolean; traversal:string; anchor:number;
  edgeId:string;routeId:string;laneSpeed:number;trafficEligible:boolean;singleLaneKey?:string;
  atGrade?:boolean;roadHalfWidthMeters?:number;signalOffsetMeters?:number;reverseSignalOffsetMeters?:number;sourceCorridorKey?:string } | null;
export interface ActorPreviewRoadHint {
  readonly geometryKind?: 'carriageway_centerline' | 'pedestrian_centerline';
  /** Known bridges/tunnels cannot use the preview's ground-level displacement. */
  readonly atGrade?: boolean;
  readonly widthM?: number;
  readonly width?: number | string;
  readonly lanes?: number;
  readonly className?: string;
  readonly oneway?:boolean;
  readonly drivable?:boolean;
  readonly gradeUnverified?:boolean;
  readonly sourceRoadIds?:readonly string[];
  readonly widthScope?:'minimum_constituent_corridor';
}
export interface ActorCorridorPreviewOptions {
  /** Explicit presentation policy retained by the Scene across bridge rebuilds. */
  readonly laneTraffic?: LaneTraffic;
  /** Must match the author of speed/route phase; never infer it from a camera. */
  readonly sourceMetric?: 'local_mercator' | 'provider_equirectangular_111195';
  /** Explicit author rule (V2 provider uses 15m); absent means no invented fade. */
  readonly onceEndpointFadeMeters?: number;
  /** This correction is exclusively a visual-synthesis preview, never surveyed sidewalk geometry. */
  readonly derivePairedSidewalks?: boolean;
  /** Exact movement edge IDs only. No name matching, nearby-road lookup or fuzzy joins. */
  readonly roadHintsByEdgeId?: ReadonlyMap<string, ActorPreviewRoadHint>;
  /** Optional source-footprint clearance test, local East/South metres and body margin. */
  readonly isPointClear?: (east: number, south: number, bodyRadiusMeters: number) => boolean;
}
const CLASS_WIDTH: Readonly<Record<string, number>> = { motorway:14,trunk:12,primary:10,secondary:9,tertiary:8,
  residential:6,unclassified:6,road:6,living_street:5,service:4,track:3,pedestrian:5,footway:2,path:1.5,cycleway:2.5,steps:2,corridor:2,platform:3 };
const SIDEWALK_CENTER_CLEARANCE = .75;
const BODY_RADIUS = .35;
function widthFor(hint: ActorPreviewRoadHint | undefined): { meters:number; source:'source_width'|'derived_lanes'|'derived_class'|'preview_fixed_5m' } {
  const raw=hint?.widthM??hint?.width;
  const width=typeof raw==='number'?raw:typeof raw==='string'&&/^\s*\d+(?:\.\d+)?\s*m?\s*$/u.test(raw)?Number(raw.trim().replace(/m$/u,'').trim()):NaN;
  if(Number.isFinite(width)&&width>=.3&&width<=40)return {meters:width,source:'source_width'};
  if(Number.isInteger(hint?.lanes)&&hint!.lanes!>=1&&hint!.lanes!<=12)return {meters:hint!.lanes!*3+.6,source:'derived_lanes'};
  if(hint?.className&&CLASS_WIDTH[hint.className]!==undefined)return {meters:CLASS_WIDTH[hint.className]!,source:'derived_class'};
  return {meters:5,source:'preview_fixed_5m'};
}
function measure(points: Point[], authoredDistances?: number[]):Road|null {
  const distances=authoredDistances??[0];
  if(!authoredDistances)for(let i=1;i<points.length;i++)distances.push(distances[i-1]!+Math.hypot(points[i]![0]-points[i-1]![0],points[i]![2]-points[i-1]![2]));
  return distances.at(-1)!>0?{points,distances,length:distances.at(-1)!}:null;
}
function providerDistances(geometry:readonly (readonly [number,number])[]):number[] {
  const result=[0];
  for(let i=1;i<geometry.length;i++){
    const a=geometry[i-1]!,b=geometry[i]!;
    result.push(result[i-1]!+Math.hypot((b[0]-a[0])*Math.cos(a[1]*Math.PI/180),b[1]-a[1])*111195);
  }
  return result;
}
/** Re-anchor the actual source coordinate, not the camera-dependent legacy progress metric. */
function distanceAtSourcePoint(road:Road,point:Point):number|null {
  let best=Infinity,distance=0;
  for(let i=1;i<road.points.length;i++){
    const a=road.points[i-1]!,b=road.points[i]!,dx=b[0]-a[0],dz=b[2]-a[2],lengthSquared=dx*dx+dz*dz;
    if(lengthSquared===0)continue;
    const t=Math.min(1,Math.max(0,((point[0]-a[0])*dx+(point[2]-a[2])*dz)/lengthSquared));
    const error=Math.hypot(a[0]+dx*t-point[0],a[2]+dz*t-point[2]);
    if(error<best){best=error;distance=road.distances[i-1]!+(road.distances[i]!-road.distances[i-1]!)*t;}
  }
  return best<=.05?distance:null;
}
function geometryKey(geometry: readonly (readonly [number,number])[]):{key:string;reversed:boolean} {
  const forward=JSON.stringify(geometry),reverse=JSON.stringify([...geometry].reverse());
  return forward<=reverse?{key:forward,reversed:false}:{key:reverse,reversed:true};
}
/** Parallel source polyline, fixed physical side even if travel direction later reverses. */
function offsetRoad(road:Road,offset:number,isClear:ActorCorridorPreviewOptions['isPointClear'],bodyRadius=BODY_RADIUS):Road|null {
  const points=road.points, normals:[number,number][]=[], directions:[number,number][]=[];
  const closed=points[0]![0]===points.at(-1)![0]&&points[0]![2]===points.at(-1)![2];
  for(let i=1;i<points.length;i++){
    const dx=points[i]![0]-points[i-1]![0],dz=points[i]![2]-points[i-1]![2],length=Math.hypot(dx,dz);
    if(length<.1)return null;
    directions.push([dx/length,dz/length]);normals.push([-dz/length,dx/length]);
  }
  const displaced:Point[]=[];
  for(let i=0;i<points.length;i++){
    let nx:number,nz:number,scale=offset;
    if(!closed&&i===0){[nx,nz]=normals[0]!;}
    else if(!closed&&i===points.length-1){[nx,nz]=normals.at(-1)!;}
    else {
      const left=(i+directions.length-1)%directions.length,right=i%directions.length;
      const a=directions[left]!,b=directions[right]!;
      // Corner/junction construction is not part of this preview. Reject the
      // displacement at sharp turns; callers see blockedActors, not a safe-path claim.
      if(a[0]*b[0]+a[1]*b[1]<.5)return null;
      const p=normals[left]!,q=normals[right]!,length=Math.hypot(p[0]+q[0],p[1]+q[1]);
      nx=(p[0]+q[0])/length;nz=(p[1]+q[1])/length;
      scale=offset/(nx*q[0]+nz*q[1]);
    }
    displaced.push([points[i]![0]+nx*scale,points[i]![1],points[i]![2]+nz*scale]);
  }
  if(isClear){
    let checks=0;
    for(let i=1;i<displaced.length;i++){
      const a=displaced[i-1]!,b=displaced[i]!,steps=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[2]-a[2])/1));
      if(checks+steps+1>2048)return null;
      for(let step=0;step<=steps;step++){const t=step/steps;checks++;if(!isClear(a[0]+(b[0]-a[0])*t,a[2]+(b[2]-a[2])*t,bodyRadius))return null;}
    }
  }
  // Sidewalk geometry is presentation-only. Keep the original source arclength
  // parameter: remeasuring the parallel path causes a snap at each provider refresh.
  return {points:displaced,distances:road.distances,length:road.length};
}
/** Retained columns, source-authored corridors. No skeleton/React update per visual frame. */
export class ActorColumnsBridge {
  readonly columns: GameActorColumns;
  readonly motionDiagnostics={sourceMetric:'local_mercator' as NonNullable<ActorCorridorPreviewOptions['sourceMetric']>,rejectedSourceAnchors:0,openLoopsClamped:0};
  readonly vehicleLanePreview={representation:'visual_synthesis' as const,bodyWidthMeters:2,minimumTwoWayWidthMeters:4.4,
    offsetVehicles:0,narrowYieldVehicles:0,turnaroundYieldVehicles:0,blockedOffsetVehicles:0,assumedLaneVehicles:0,undisplacedYieldVehicles:0,
    offsets:[] as {id:string;edgeId:string;meters:number;widthMeters:number;widthSource:string;lanes:number;laneCountSource:'source'|'assumed_two_way'}[]};
  readonly sidewalkPreview = { representation:'visual_synthesis' as const, scope:'source_centerline_preview' as const,
    derivedActors:0,unchangedActors:0,blockedActors:0,uncheckedActors:0,defaultWidthActors:0,
    clearance:'unverified_preview' as 'source_footprints_checked'|'unverified_preview',
    offsets:[] as {id:string;edgeId:string;meters:number;widthSource:ReturnType<typeof widthFor>['source'];clearance:'source_footprints_checked'|'unverified_preview'}[] };
  private readonly bindings: Binding[];
  private readonly anchors: [number,number,number][];
  private readonly onceEndpointFadeMeters:number|null;
  private readonly laneTraffic:LaneTraffic|undefined;
  readonly trafficPresentation:{policy:LaneTraffic['policy'];managedVehicles:number;managedPedestrians:number;unsupportedTraversalVehicles:number;unsupportedTraversalPedestrians:number}|null;
  constructor(entities:readonly VisualEntity[], movement:WorldSceneMovementPayload|null|undefined,
    sources:readonly LivingSceneMovementEntitySource[], origin:GameOrigin, timeOriginSeconds=0, preview:ActorCorridorPreviewOptions={}) {
    const fade=preview.onceEndpointFadeMeters;
    this.laneTraffic=preview.laneTraffic;
    if(fade!==undefined&&(!Number.isFinite(fade)||fade<=0))throw Error('Once endpoint fade must be explicit positive metres');
    this.onceEndpointFadeMeters=fade??null;
    const anchor=MercatorCoordinate.fromLngLat([origin.longitude,origin.latitude],origin.altitude??0);
    const meter=anchor.meterInMercatorCoordinateUnits();
    const local=(lon:number,lat:number,elevation=0):[number,number,number]=>{
      const p=MercatorCoordinate.fromLngLat([lon,lat]); return [(p.x-anchor.x)/meter,elevation,(p.y-anchor.y)/meter];
    };
    const roads=new Map<string,Road>();
    this.motionDiagnostics.sourceMetric=preview.sourceMetric??'local_mercator';
    const signatures=new Map<string,ReturnType<typeof geometryKey>>();
    const laneByGeometry=new Map<string,string>();
    for(const edge of movement?.edges??[]) {
      const points=edge.geometry.map(p=>local(p[0],p[1],0.13));
      const road=measure(points,preview.sourceMetric==='provider_equirectangular_111195'?providerDistances(edge.geometry):undefined);if(road)roads.set(edge.edgeId,road);
      const signature=geometryKey(edge.geometry);signatures.set(edge.edgeId,signature);
      if(edge.edgeKind==='lane'){
        const previous=laneByGeometry.get(signature.key);
        if(previous===undefined||edge.edgeId<previous)laneByGeometry.set(signature.key,edge.edgeId);
      }
    }
    const edgeById=new Map((movement?.edges??[]).map(edge=>[edge.edgeId,edge]));
    const displaced=new Map<string,Road|null>();
    this.sidewalkPreview.clearance=preview.isPointClear?'source_footprints_checked':'unverified_preview';
    const routes=new Map((movement?.routes??[]).map(r=>[r.routeId,r]));
    const motions=new Map(sources.map(r=>[r.id,r]));
    this.bindings=entities.map(entity=>{
      const source=motions.get(entity.id), motion=source?.motion;
      const edgeId=motion?.edgeId??'',edge=edgeById.get(edgeId),signature=signatures.get(edgeId);
      let road=roads.get(edgeId);
      let progress=motion?.progress??null;
      if(road&&preview.sourceMetric==='provider_equirectangular_111195'&&motion?.mode==='network_edge'){
        const distance=distanceAtSourcePoint(road,local(entity.longitude,entity.latitude));
        if(distance===null){this.motionDiagnostics.rejectedSourceAnchors++;return null;}
        progress=distance/road.length;
      }
      const lane=signature?laneByGeometry.get(signature.key):undefined;
      const roadHint=preview.roadHintsByEdgeId?.get(edgeId)??preview.roadHintsByEdgeId?.get(lane??'');
      const width=widthFor(roadHint);
      let displayOffset=0;
      // An explicit source carriageway does not depend on whether a car happens
      // to be in this actor sample. Unpaired correction requires verified clearance.
      const knownCarriageway=roadHint?.geometryKind==='carriageway_centerline'&&roadHint.atGrade===true
        &&Boolean(preview.isPointClear)&&width.source!=='preview_fixed_5m';
      // A dedicated source footway/crosswalk must never receive a second offset.
      if(preview.derivePairedSidewalks!==false&&roadHint?.atGrade!==false&&roadHint?.geometryKind!=='pedestrian_centerline'
        &&entity.kind!=='vehicle'&&edge?.edgeKind==='sidewalk'&&!edge.crossesRoad&&(lane||knownCarriageway)&&road&&signature){
        const side=((entity.seed??0)&1)?1:-1;
        const offset=(width.meters/2+SIDEWALK_CENTER_CLEARANCE)*side*(signature.reversed?-1:1);
        const key=`${edgeId}:${offset}`;
        if(!displaced.has(key))displaced.set(key,offsetRoad(road,offset,preview.isPointClear));
        const alternate=displaced.get(key);
        if(alternate){
          road=alternate;displayOffset=offset;this.sidewalkPreview.derivedActors++;
          if(!preview.isPointClear)this.sidewalkPreview.uncheckedActors++;
          if(width.source==='preview_fixed_5m')this.sidewalkPreview.defaultWidthActors++;
          this.sidewalkPreview.offsets.push({id:entity.id,edgeId,meters:offset,widthSource:width.source,clearance:this.sidewalkPreview.clearance});
        }else this.sidewalkPreview.blockedActors++;
      }else this.sidewalkPreview.unchangedActors++;
      let traversal=routes.get(motion?.routeId??'')?.traversal??'once';
      if(road&&traversal==='loop'){
        const a=road.points[0]!,b=road.points.at(-1)!;
        if(Math.hypot(a[0]-b[0],a[2]-b[2])>.001){traversal='once';this.motionDiagnostics.openLoopsClamped++;}
      }
      let singleLaneKey:string|undefined;
      if(this.laneTraffic&&entity.kind==='vehicle'&&edge?.edgeKind==='lane'&&road&&signature&&(traversal==='once'||traversal==='ping_pong')){
        const twoWay=roadHint?.oneway===false||roadHint?.oneway===undefined&&edge.direction==='bidirectional';
        if(traversal==='ping_pong'){
          // A source turnaround supplies no connecting lane-change geometry.
          // Keep its authored corridor and reserve one direction at a time.
          singleLaneKey=signature.key;this.vehicleLanePreview.turnaroundYieldVehicles++;
        }else if(twoWay){
          const info=resolveGameRoadWidth(roadHint??{}),lanes=roadHint?.lanes&&roadHint.lanes>=2?roadHint.lanes:2;
          const known=roadHint?.geometryKind==='carriageway_centerline'&&roadHint.atGrade===true&&roadHint.drivable!==false;
          const offset=(info.width/2-info.width/lanes/2)*(motion?.direction==='reverse'?-1:1);
          const canAllocate=known&&roadHint?.lanes!==1&&info.width>=this.vehicleLanePreview.minimumTwoWayWidthMeters;
          const key=`vehicle:${edgeId}:${offset}`;
          if(canAllocate&&!displaced.has(key))displaced.set(key,offsetRoad(road,offset,preview.isPointClear,1));
          const alternate=canAllocate?displaced.get(key):null;
          if(alternate){
            road=alternate;displayOffset=offset;this.vehicleLanePreview.offsetVehicles++;
            const laneCountSource=roadHint?.lanes&&roadHint.lanes>=2?'source':'assumed_two_way';
            if(laneCountSource==='assumed_two_way')this.vehicleLanePreview.assumedLaneVehicles++;
            this.vehicleLanePreview.offsets.push({id:entity.id,edgeId,meters:offset,widthMeters:info.width,widthSource:info.source,lanes,laneCountSource});
          }else{
            singleLaneKey=signature.key;this.vehicleLanePreview.narrowYieldVehicles++;
            if(canAllocate)this.vehicleLanePreview.blockedOffsetVehicles++;
          }
        }
        if(!singleLaneKey&&displayOffset===0){
          // Separate forward-only source edges can encode opposite travel on
          // this same centreline. Missing lane/grade metadata does not create
          // room for two bodies: reserve the exact undisplaced source geometry.
          singleLaneKey=signature.key;this.vehicleLanePreview.undisplacedYieldVehicles++;
        }
      }
      const roadHalfWidthMeters=(entity.kind==='vehicle'?resolveGameRoadWidth(roadHint??{}).width:width.meters)/2;
      const directionSign=traversal==='ping_pong'?1:motion?.direction==='reverse'?-1:1;
      const side=displayOffset*directionSign;
      const signalOffsetMeters=roadHint?.atGrade===true&&roadHint.geometryKind
        ?entity.kind!=='vehicle'&&displayOffset!==0?Math.sign(side)*.8:roadHalfWidthMeters+.4-side:undefined;
      const reverseSignalOffsetMeters=traversal==='ping_pong'&&signalOffsetMeters!==undefined
        ?entity.kind!=='vehicle'&&displayOffset!==0?-Math.sign(side)*.8:roadHalfWidthMeters+.4+side:undefined;
      return road&&motion?.mode==='network_edge'&&progress!==null ? {road,progress,speed:motion.speedMps,
        reverse:motion.direction==='reverse',traversal,anchor:Date.parse(source!.presentationTime)/1000-timeOriginSeconds,
        edgeId,routeId:motion.routeId??'',laneSpeed:entity.kind==='vehicle'?edge?.visualSpeedMetersPerSecond.car??edge?.visualSpeedMetersPerSecond.transit??motion.speedMps:motion.speedMps,
        trafficEligible:(entity.kind==='vehicle'?edge?.edgeKind==='lane':edge?.edgeKind==='sidewalk'||edge?.crossesRoad===true)&&(traversal==='once'||traversal==='ping_pong'),
        singleLaneKey,atGrade:roadHint?.gradeUnverified?undefined:roadHint?.atGrade,roadHalfWidthMeters,signalOffsetMeters,reverseSignalOffsetMeters,
        sourceCorridorKey:roadHint?.sourceRoadIds?.length?JSON.stringify([...roadHint.sourceRoadIds].sort()):undefined}:null;
    });
    if(this.laneTraffic){
      const physical=new Map<Road,number[]>();
      const vehicles:LaneTrafficVehicle[]=this.bindings.flatMap((binding,index)=>{
        if(!binding?.trafficEligible)return [];
        const {road}=binding;
        let distances=physical.get(road);
        if(!distances){distances=[0];for(let i=1;i<road.points.length;i++)distances.push(distances[i-1]!+Math.hypot(road.points[i]![0]-road.points[i-1]![0],road.points[i]![2]-road.points[i-1]![2]));physical.set(road,distances);}
        const source=Math.max(0,Math.min(road.length,binding.progress*road.length));
        let segment=1;while(segment<road.distances.length-1&&road.distances[segment]!<source)segment++;
        const t=(source-road.distances[segment-1]!)/(road.distances[segment]!-road.distances[segment-1]!);
        const along=distances[segment-1]!+(distances[segment]!-distances[segment-1]!)*t;
        const path=road.points.map(point=>[point[0],point[2]] as const);
        return [{id:entities[index]!.id,routeKey:`${binding.routeId}:${binding.edgeId}:${binding.traversal==='ping_pong'?'ping_pong':binding.reverse?'reverse':'forward'}`,
          path:binding.traversal==='ping_pong'?path:binding.reverse?path.reverse():path,sourceDistance:binding.reverse?distances.at(-1)!-along:along,
          sourceTime:binding.anchor,sourceSpeed:binding.speed,laneSpeed:binding.laneSpeed,singleLaneKey:binding.singleLaneKey,
          kind:entities[index]!.kind==='vehicle'?'vehicle' as const:'pedestrian' as const,atGrade:binding.atGrade,
          sourceCorridorKey:binding.sourceCorridorKey,
          roadHalfWidthMeters:binding.roadHalfWidthMeters,signalOffsetMeters:binding.signalOffsetMeters,reverseSignalOffsetMeters:binding.reverseSignalOffsetMeters,
          sourcePhase:{distance:binding.reverse?road.length-source:source,length:road.length,speed:binding.speed},
          traversal:binding.traversal as 'once'|'ping_pong',sourceDirection:binding.reverse?'reverse':'forward'}];
      });
      this.laneTraffic.sync(vehicles,{isPointClear:preview.isPointClear});
      this.trafficPresentation={policy:this.laneTraffic.policy,managedVehicles:vehicles.filter(actor=>actor.kind!=='pedestrian').length,
        managedPedestrians:vehicles.filter(actor=>actor.kind==='pedestrian').length,
        unsupportedTraversalVehicles:this.bindings.filter((binding,index)=>entities[index]!.kind==='vehicle'&&binding&&!binding.trafficEligible).length,
        unsupportedTraversalPedestrians:this.bindings.filter((binding,index)=>entities[index]!.kind!=='vehicle'&&binding&&!binding.trafficEligible).length};
    }else this.trafficPresentation=null;
    this.anchors=entities.map(e=>local(e.longitude,e.latitude,0.13));
    this.columns={ids:entities.map(e=>e.id),kinds:Uint8Array.from(entities,e=>e.kind==='vehicle'?1:0),
      seeds:Uint32Array.from(entities,e=>e.seed??0), previousPositions:new Float32Array(entities.length*3),
      nextPositions:new Float32Array(entities.length*3),headings:Float32Array.from(entities,e=>e.heading??0),
      previousOpacities:new Float32Array(entities.length).fill(1),nextOpacities:new Float32Array(entities.length).fill(1),
      walking:Uint8Array.from(entities,e=>e.kind==='vehicle'?0:1),previousTime:0,currentTime:0};
  }
  private position(i:number,time:number,target:Float32Array,opacities:Float32Array,traffic?:LaneTrafficSample):void {
    opacities[i]=1;
    if(traffic){
      target.set([traffic.point[0],.13,traffic.point[1]],i*3);this.columns.headings[i]=traffic.heading;
      opacities[i]=traffic.visible?this.onceEndpointFadeMeters===null||traffic.traversal==='ping_pong'?1:Math.max(0,Math.min(1,traffic.distance/this.onceEndpointFadeMeters,(traffic.length-traffic.distance)/this.onceEndpointFadeMeters)):0;
      return;
    }
    const binding=this.bindings[i];
    if(!binding){target.set(this.anchors[i]!,i*3);return;}
    const {road,speed,anchor,progress,reverse,traversal}=binding;
    const elapsed=Math.max(0,time-anchor);
    let distance=progress*road.length+(reverse?-1:1)*speed*elapsed, backwards=reverse;
    if(traversal==='loop')distance=((distance%road.length)+road.length)%road.length;
    else if(traversal==='ping_pong'){
      const phase=(((reverse?2*road.length-progress*road.length:progress*road.length)+speed*elapsed)%(2*road.length)+2*road.length)%(2*road.length);
      backwards=phase>road.length;distance=backwards?2*road.length-phase:phase;
    } else {
      if(this.onceEndpointFadeMeters!==null)opacities[i]=Math.max(0,Math.min(1,distance/this.onceEndpointFadeMeters,(road.length-distance)/this.onceEndpointFadeMeters));
      distance=Math.min(road.length,Math.max(0,distance));
    }
    // Bounded logarithmic lookup even on long, detailed source polylines.
    let low=1,high=road.distances.length-1;
    while(low<high){const middle=(low+high)>>>1;if(road.distances[middle]!<distance)low=middle+1;else high=middle;}
    const j=low;
    const a=road.points[j-1]!,b=road.points[j]!, t=(distance-road.distances[j-1]!)/(road.distances[j]!-road.distances[j-1]!||1);
    target[i*3]=a[0]+(b[0]-a[0])*t;target[i*3+1]=a[1];target[i*3+2]=a[2]+(b[2]-a[2])*t;
    this.columns.headings[i]=(Math.atan2(b[0]-a[0],-(b[2]-a[2]))*180/Math.PI+(backwards?180:0)+360)%360;
  }
  sample(time:number,interval=0.2):GameActorColumns {
    const traffic=this.laneTraffic?.sampleWindow(time,interval);
    for(let i=0;i<this.bindings.length;i++){
      this.position(i,time+interval,this.columns.nextPositions,this.columns.nextOpacities!,traffic?.next.get(this.columns.ids[i]!));
      this.position(i,time,this.columns.previousPositions,this.columns.previousOpacities!,traffic?.previous.get(this.columns.ids[i]!));
      const previous=this.columns.previousPositions,next=this.columns.nextPositions;
      this.columns.walking[i]=this.columns.kinds[i]===0&&Math.hypot(next[i*3]!-previous[i*3]!,next[i*3+2]!-previous[i*3+2]!)>0.001?1:0;
    }
    this.columns.previousTime=time;this.columns.currentTime=time+interval;return this.columns;
  }
}
