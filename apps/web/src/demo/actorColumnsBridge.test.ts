import { describe,expect,it } from 'vitest';
import { ActorColumnsBridge } from '../renderer/game/actorColumnsBridge';
import { MercatorCoordinate } from 'maplibre-gl';
import type { VisualEntity,WorldSceneMovementPayload } from '../renderer/types';
import { LaneTraffic } from '../renderer/game/laneTraffic';
const origin={longitude:61.39466,latitude:55.1654};
const entity:VisualEntity={id:'fixture',kind:'person',representation:'focus_person_1to1',representedCount:1,longitude:origin.longitude,latitude:origin.latitude,heading:90,activity:'walk',color:'#dddddd',seed:15};
const source={id:'fixture',entityKind:'person' as const,presentationTime:'2026-01-01T00:00:00Z',motion:{mode:'network_edge' as const,routeId:'r',edgeId:'e',progress:0.5,speedMps:1,direction:'forward' as const}};
const movement:WorldSceneMovementPayload={nodes:[],edges:[{edgeId:'e',fromNodeId:'a',toNodeId:'b',edgeKind:'sidewalk',crossesRoad:false,direction:'bidirectional',allowedModes:['pedestrian'],geometry:[[origin.longitude,origin.latitude],[origin.longitude+.001,origin.latitude]],visualSpeedMetersPerSecond:{pedestrian:1,car:null,bicycle:null,transit:null}}],routes:[{routeId:'r',mode:'pedestrian',edgeIds:['e'],traversal:'ping_pong'}]};
describe('game source corridor columns',()=>{
  it('registers source pedestrians with junction control without changing their columns or source IDs',()=>{
    const laneTraffic=new LaneTraffic();
    const bridge=new ActorColumnsBridge([entity],movement,[source],origin,Date.UTC(2026,0,1)/1000,{laneTraffic});
    bridge.sample(0);
    expect(bridge.trafficPresentation).toMatchObject({managedVehicles:0,managedPedestrians:1});
    expect(laneTraffic.readProbe().pedestrians.map(row=>row.id)).toEqual([entity.id]);
    expect(bridge.columns.ids).toEqual([entity.id]);expect(bridge.columns.kinds[0]).toBe(0);
  });
  it('retains opt-in vehicle convoy phase, exact IDs and lane geometry across provider refresh and reordering',()=>{
    const laneTraffic=new LaneTraffic(),epoch=Date.UTC(2026,0,1)/1000;
    const graph:WorldSceneMovementPayload={nodes:[],edges:[{...movement.edges[0]!,edgeKind:'lane',allowedModes:['car'],
      geometry:[[origin.longitude,origin.latitude],[origin.longitude+.006,origin.latitude]],
      visualSpeedMetersPerSecond:{pedestrian:null,car:8,bicycle:null,transit:null}}],routes:[{routeId:'r',mode:'car',edgeIds:['e'],traversal:'once'}]};
    const start=MercatorCoordinate.fromLngLat([origin.longitude,origin.latitude]),end=MercatorCoordinate.fromLngLat([origin.longitude+.006,origin.latitude]);
    const length=(end.x-start.x)/start.meterInMercatorCoordinateUnits();
    const cars=[{...entity,id:'front',kind:'vehicle' as const},{...entity,id:'rear',kind:'vehicle' as const}];
    const rows=[{...source,id:'front',entityKind:'vehicle' as const,motion:{...source.motion,progress:100/length,speedMps:7}},
      {...source,id:'rear',entityKind:'vehicle' as const,motion:{...source.motion,progress:70/length,speedMps:10}}];
    const first=new ActorColumnsBridge(cars,graph,rows,origin,epoch,{laneTraffic});
    first.sample(0);const before=first.sample(5),positions=new Map(before.ids.map((id,i)=>[id,before.previousPositions[i*3]!]));
    const refreshed=rows.map((row,i)=>({...row,presentationTime:'2026-01-01T00:00:05Z',motion:{...row.motion,progress:row.motion.progress+[35,50][i]!/length}}));
    const second=new ActorColumnsBridge([...cars].reverse(),graph,refreshed,origin,epoch,{laneTraffic}),after=second.sample(5);
    expect(after.ids).toEqual(['rear','front']);expect(Array.from(after.kinds)).toEqual([1,1]);
    for(let i=0;i<after.ids.length;i++){expect(after.previousPositions[i*3]).toBeCloseTo(positions.get(after.ids[i]!)!,4);expect(after.previousPositions[i*3+2]).toBeCloseTo(0,5);
      expect(after.nextPositions[i*3]!-after.previousPositions[i*3]!).toBeCloseTo(1.6,3);}
    expect(second.trafficPresentation).toMatchObject({managedVehicles:2,unsupportedTraversalVehicles:0,policy:{representation:'visual_synthesis',bumperGapMeters:2}});
    const absent=new ActorColumnsBridge([cars[1]!],graph,[refreshed[1]!],origin,epoch,{laneTraffic}).sample(5);
    expect(absent.ids).toEqual(['rear']);expect(laneTraffic.sampleWindow(5).previous.has('front')).toBe(false);
  });
  it('allocates right-hand visual lanes within the shared source road width for opposing cars',()=>{
    const laneTraffic=new LaneTraffic(),graph={...movement,edges:[{...movement.edges[0]!,edgeKind:'lane' as const,allowedModes:['car' as const],
      visualSpeedMetersPerSecond:{pedestrian:null,car:8,bicycle:null,transit:null}}],routes:[{routeId:'r',mode:'car' as const,edgeIds:['e'],traversal:'once' as const}]};
    const cars=[{...entity,id:'forward',kind:'vehicle' as const},{...entity,id:'reverse',kind:'vehicle' as const}];
    const rows=cars.map((car,i)=>({...source,id:car.id,entityKind:'vehicle' as const,motion:{...source.motion,speedMps:8,direction:i?'reverse' as const:'forward' as const}}));
    const bridge=new ActorColumnsBridge(cars,graph,rows,origin,Date.UTC(2026,0,1)/1000,{laneTraffic,
      roadHintsByEdgeId:new Map([['e',{atGrade:true,geometryKind:'carriageway_centerline',widthM:6,lanes:2,oneway:false,drivable:true}]])});
    const frame=bridge.sample(0);
    expect(frame.previousPositions[2]).toBeCloseTo(1.5,4);expect(frame.previousPositions[5]).toBeCloseTo(-1.5,4);
    expect(frame.headings[0]).toBeCloseTo(90);expect(frame.headings[1]).toBeCloseTo(270);
    expect(bridge.vehicleLanePreview).toMatchObject({representation:'visual_synthesis',offsetVehicles:2,narrowYieldVehicles:0,bodyWidthMeters:2});
  });
  it('keeps both source identities but admits one direction on a narrow undivided road',()=>{
    const laneTraffic=new LaneTraffic(),graph={...movement,edges:[{...movement.edges[0]!,edgeKind:'lane' as const,allowedModes:['car' as const],
      visualSpeedMetersPerSecond:{pedestrian:null,car:8,bicycle:null,transit:null}}],routes:[{routeId:'r',mode:'car' as const,edgeIds:['e'],traversal:'once' as const}]};
    const cars=[{...entity,id:'a',kind:'vehicle' as const},{...entity,id:'b',kind:'vehicle' as const}];
    const rows=cars.map((car,i)=>({...source,id:car.id,entityKind:'vehicle' as const,motion:{...source.motion,speedMps:8,direction:i?'reverse' as const:'forward' as const}}));
    const bridge=new ActorColumnsBridge(cars,graph,rows,origin,Date.UTC(2026,0,1)/1000,{laneTraffic,
      roadHintsByEdgeId:new Map([['e',{atGrade:true,geometryKind:'carriageway_centerline',className:'service',oneway:false,drivable:true}]])});
    const frame=bridge.sample(0);expect(frame.ids).toEqual(['a','b']);expect([...frame.previousOpacities!].filter(value=>value>0)).toHaveLength(1);
    expect(frame.previousPositions[2]).toBeCloseTo(0);expect(frame.previousPositions[5]).toBeCloseTo(0);
    expect(bridge.vehicleLanePreview.narrowYieldVehicles).toBe(2);
  });
  it('reserves an undisplaced bridge corridor across opposite forward-only source edges',()=>{
    const laneTraffic=new LaneTraffic(),base={...movement.edges[0]!,edgeKind:'lane' as const,allowedModes:['car' as const],direction:'forward' as const,
      visualSpeedMetersPerSecond:{pedestrian:null,car:8,bicycle:null,transit:null}};
    const graph:WorldSceneMovementPayload={nodes:[],edges:[base,{...base,edgeId:'reverse-edge',geometry:[...base.geometry].reverse()}],
      routes:[{routeId:'r',mode:'car',edgeIds:['e'],traversal:'once'},{routeId:'reverse-route',mode:'car',edgeIds:['reverse-edge'],traversal:'once'}]};
    const cars=[{...entity,id:'a',kind:'vehicle' as const},{...entity,id:'b',kind:'vehicle' as const}];
    const rows=cars.map((car,i)=>({...source,id:car.id,entityKind:'vehicle' as const,
      motion:{...source.motion,edgeId:i?'reverse-edge':'e',routeId:i?'reverse-route':'r',speedMps:8}}));
    const bridge=new ActorColumnsBridge(cars,graph,rows,origin,Date.UTC(2026,0,1)/1000,{laneTraffic,
      roadHintsByEdgeId:new Map(['e','reverse-edge'].map(id=>[id,{atGrade:false,sourceRoadIds:['bridge']}]))});
    const frame=bridge.sample(0);expect(frame.ids).toEqual(['a','b']);
    expect([...frame.previousOpacities!].filter(value=>value>0)).toHaveLength(1);
    for(let time=.1;time<2;time+=.1){
      const sample=bridge.sample(time);expect([...sample.previousOpacities!].filter(value=>value>0)).toHaveLength(1);
    }
  });
  it('regulates an authored ping-pong vehicle without applying once-endpoint disappearance',()=>{
    const laneTraffic=new LaneTraffic(),graph={...movement,edges:[{...movement.edges[0]!,edgeKind:'lane' as const,allowedModes:['car' as const],
      visualSpeedMetersPerSecond:{pedestrian:null,car:7,bicycle:null,transit:null}}],routes:[{routeId:'r',mode:'car' as const,edgeIds:['e'],traversal:'ping_pong' as const}]};
    const car={...entity,kind:'vehicle' as const},row={...source,entityKind:'vehicle' as const,motion:{...source.motion,progress:.99,speedMps:7}};
    const bridge=new ActorColumnsBridge([car],graph,[row],origin,Date.UTC(2026,0,1)/1000,{laneTraffic,onceEndpointFadeMeters:15});
    expect(bridge.trafficPresentation).toMatchObject({managedVehicles:1,unsupportedTraversalVehicles:0});
    const first=bridge.sample(0);expect(first.previousOpacities![0]).toBe(1);expect(first.nextOpacities![0]).toBe(1);
    const after=bridge.sample(1);expect(after.ids).toEqual([car.id]);expect(after.previousOpacities![0]).toBe(1);expect(after.headings[0]).toBeCloseTo(270);
    expect(bridge.vehicleLanePreview.turnaroundYieldVehicles).toBe(1);
  });
  it('retains static arrays and interpolates exact physical speed in metres',()=>{
    const bridge=new ActorColumnsBridge([entity],movement,[source],origin,Date.UTC(2026,0,1)/1000);
    const first=bridge.sample(1),ids=first.ids,previous=first.previousPositions,start=first.previousPositions[0]!;
    expect(first.currentTime-first.previousTime).toBeCloseTo(.2);
    expect(first.nextPositions[0]!-start).toBeCloseTo(.2,3);
    expect(first.headings[0]).toBeCloseTo(90);
    const later=bridge.sample(2);expect(later.ids).toBe(ids);expect(later.previousPositions).toBe(previous);
    expect(later.previousPositions[0]!-start).toBeCloseTo(1,3);
    expect(later.previousPositions[1]).toBeCloseTo(.13);
  });
  it('keeps stationary fallback at source coordinates without inventing a route',()=>{
    const bridge=new ActorColumnsBridge([entity],null,[],origin);const col=bridge.sample(500);
    expect(Array.from(col.previousPositions)).toEqual(Array.from(col.nextPositions));
    expect(col.previousPositions[0]).toBeCloseTo(0);expect(col.previousPositions[2]).toBeCloseTo(0);
    expect(col.walking[0]).toBe(0);
  });
  it('switches a pedestrian to the idle clip at a corridor endpoint',()=>{
    const once={...movement,routes:[{...movement.routes[0]!,traversal:'once' as const}]};
    const bridge=new ActorColumnsBridge([entity],once,[source],origin,Date.UTC(2026,0,1)/1000);
    expect(bridge.sample(1).walking[0]).toBe(1);
    expect(bridge.sample(10000).walking[0]).toBe(0);
  });
  const paired=():WorldSceneMovementPayload=>({...movement,edges:[movement.edges[0]!,{
    ...movement.edges[0]!,edgeId:'lane',edgeKind:'lane',allowedModes:['car'],direction:'forward',
    visualSpeedMetersPerSecond:{pedestrian:null,car:8,bicycle:null,transit:null},
  }],routes:[...movement.routes,{routeId:'car-route',mode:'car',edgeIds:['lane'],traversal:'once'}]});
  it('separates a paired sidewalk from its lane by physical road half-width plus margin',()=>{
    const car={...entity,id:'car',kind:'vehicle' as const};
    const carSource={...source,id:'car',entityKind:'vehicle' as const,motion:{...source.motion,edgeId:'lane',routeId:'car-route'}};
    const bridge=new ActorColumnsBridge([entity,car],paired(),[source,carSource],origin,Date.UTC(2026,0,1)/1000,
      {roadHintsByEdgeId:new Map([['lane',{widthM:8}]])});
    const result=bridge.sample(1);
    expect(Math.abs(result.previousPositions[2]!-result.previousPositions[5]!)).toBeCloseTo(4.75,5);
    expect(result.previousPositions[0]).toBeCloseTo(result.previousPositions[3]!,4);
    expect(result.previousPositions[1]).toBeCloseTo(.13);expect(result.previousPositions[4]).toBeCloseTo(.13);
    expect(result.headings[0]).toBeCloseTo(90);expect(result.headings[1]).toBeCloseTo(90);
    expect(bridge.sidewalkPreview.derivedActors).toBe(1);expect(bridge.sidewalkPreview.offsets[0]!.widthSource).toBe('source_width');
    expect(bridge.sidewalkPreview.representation).toBe('visual_synthesis');
    expect(bridge.sidewalkPreview.clearance).toBe('unverified_preview');
    const ids=result.ids,positions=result.previousPositions;bridge.sample(2);
    expect(bridge.columns.ids).toBe(ids);expect(bridge.columns.previousPositions).toBe(positions);
  });
  it('keeps a stable physical side when travel reverses or source geometry order reverses',()=>{
    const make=(reverse:boolean,reverseGeometry=false)=>{
      const data=paired();
      const graph=reverseGeometry?{...data,edges:[{...data.edges[0]!,geometry:[...data.edges[0]!.geometry].reverse()},data.edges[1]!]}:data;
      return new ActorColumnsBridge([entity],graph,[{...source,motion:{...source.motion,direction:reverse?'reverse':'forward'}}],origin,Date.UTC(2026,0,1)/1000);
    };
    const forward=make(false),reverse=make(true),reordered=make(false,true);
    const f=forward.sample(0),r=reverse.sample(0),g=reordered.sample(0);
    expect(f.previousPositions[2]).toBeCloseTo(r.previousPositions[2]!,5);
    expect(f.previousPositions[2]).toBeCloseTo(g.previousPositions[2]!,5);
    expect(f.previousPositions[0]).toBeCloseTo(g.previousPositions[0]!,4);
    expect(f.headings[0]).toBeCloseTo(90);expect(r.headings[0]).toBeCloseTo(270);
    expect(forward.sample(1).previousPositions[2]).toBeCloseTo(reverse.sample(1).previousPositions[2]!,5);
  });
  it('keeps genuine source footways and crossings unchanged rather than offsetting twice',()=>{
    const data=paired();
    const dedicated={...data,edges:[{...data.edges[0]!,geometry:data.edges[0]!.geometry.map(([lon,lat])=>[lon,lat+.0001] as const)},data.edges[1]!]};
    const actual=new ActorColumnsBridge([entity],dedicated,[source],origin,Date.UTC(2026,0,1)/1000);
    const uncorrected=new ActorColumnsBridge([entity],dedicated,[source],origin,Date.UTC(2026,0,1)/1000,{derivePairedSidewalks:false});
    expect(Array.from(actual.sample(1).previousPositions)).toEqual(Array.from(uncorrected.sample(1).previousPositions));
    expect(actual.sidewalkPreview.derivedActors).toBe(0);
    const crossing={...data,edges:[{...data.edges[0]!,edgeKind:'crosswalk' as const,crossesRoad:true},data.edges[1]!]};
    const cross=new ActorColumnsBridge([entity],crossing,[source],origin,Date.UTC(2026,0,1)/1000);
    expect(cross.sample(1).previousPositions[2]).toBeCloseTo(0,5);expect(cross.sidewalkPreview.derivedActors).toBe(0);
  });
  it('makes unknown, lane-derived and class-derived widths explicitly diagnostic',()=>{
    for(const [hint,offset,label] of [[undefined,3.25,'preview_fixed_5m'],[{lanes:2},4.05,'derived_lanes'],[{className:'residential'},3.75,'derived_class']] as const){
      const bridge=new ActorColumnsBridge([entity],paired(),[source],origin,Date.UTC(2026,0,1)/1000,
        hint?{roadHintsByEdgeId:new Map([['lane',hint]])}:{});
      expect(Math.abs(bridge.sample(1).previousPositions[2]!)).toBeCloseTo(offset,5);
      expect(bridge.sidewalkPreview.offsets[0]!.widthSource).toBe(label);
      expect(bridge.sidewalkPreview.defaultWidthActors).toBe(hint?0:1);
    }
  });
  it('never replaces a known bridge or tunnel with a default at-grade sidewalk',()=>{
    const bridge=new ActorColumnsBridge([entity],paired(),[source],origin,Date.UTC(2026,0,1)/1000,
      {roadHintsByEdgeId:new Map([['lane',{className:'primary',atGrade:false}]])});
    expect(bridge.sidewalkPreview.derivedActors).toBe(0);
    expect(bridge.sample(1).previousPositions[2]).toBeCloseTo(0,5);
  });
  it('refuses sharp-bend displacement and obstructed sidewalk previews without fabricating routes',()=>{
    const data=paired(),geometry:readonly (readonly [number,number])[]=[[origin.longitude,origin.latitude],[origin.longitude+.001,origin.latitude],[origin.longitude+.001,origin.latitude+.001]];
    const bent={...data,edges:data.edges.map(edge=>({...edge,geometry}))};
    const sharp=new ActorColumnsBridge([entity],bent,[source],origin,Date.UTC(2026,0,1)/1000);
    expect(sharp.sidewalkPreview.blockedActors).toBe(1);expect(sharp.sidewalkPreview.derivedActors).toBe(0);
    const blocked=new ActorColumnsBridge([entity],paired(),[source],origin,Date.UTC(2026,0,1)/1000,{isPointClear:()=>false});
    expect(blocked.sidewalkPreview.blockedActors).toBe(1);expect(blocked.sample(1).previousPositions[2]).toBeCloseTo(0,5);
    const guarded=new ActorColumnsBridge([entity],paired(),[source],origin,Date.UTC(2026,0,1)/1000,{isPointClear:(_x,_z,radius)=>radius===.35});
    expect(guarded.sidewalkPreview.clearance).toBe('source_footprints_checked');expect(guarded.sidewalkPreview.uncheckedActors).toBe(0);
    expect(guarded.sidewalkPreview.derivedActors).toBe(1);
  });
  it('keeps derived sidewalk phase continuous when provider reanchors the same source road',()=>{
    const geometry:readonly (readonly [number,number])[]=[[origin.longitude,origin.latitude],[origin.longitude+.001,origin.latitude],[origin.longitude+.002,origin.latitude+.0003]];
    const graph={...paired(),edges:paired().edges.map(edge=>({...edge,geometry}))};
    const anchor=MercatorCoordinate.fromLngLat([origin.longitude,origin.latitude]);
    const meter=anchor.meterInMercatorCoordinateUnits(),points=geometry.map(p=>MercatorCoordinate.fromLngLat([p[0],p[1]]));
    const length=points.slice(1).reduce((sum,p,i)=>sum+Math.hypot(p.x-points[i]!.x,p.y-points[i]!.y)/meter,0);
    const opts={roadHintsByEdgeId:new Map([['lane',{widthM:8}]]),isPointClear:()=>true};
    const first={...source,motion:{...source.motion,progress:.3}};
    const next={...first,presentationTime:'2026-01-01T00:00:05Z',motion:{...first.motion,progress:.3+5/length}};
    const before=new ActorColumnsBridge([entity],graph,[first],origin,Date.UTC(2026,0,1)/1000,opts);
    const after=new ActorColumnsBridge([entity],graph,[next],origin,Date.UTC(2026,0,1)/1000,opts);
    const p=Array.from(before.sample(5).previousPositions),q=Array.from(after.sample(5).previousPositions);
    expect(Math.hypot(p[0]!-q[0]!,p[2]!-q[2]!)).toBeLessThan(.0001);
  });
  it('never teleports from the end of an open edge marked as a loop',()=>{
    const graph={...movement,routes:[{...movement.routes[0]!,traversal:'loop' as const}]};
    const bridge=new ActorColumnsBridge([entity],graph,[source],origin,Date.UTC(2026,0,1)/1000);
    const start=bridge.sample(0).previousPositions[0]!;
    expect(bridge.sample(10000).previousPositions[0]).toBeCloseTo(start*2,3);
    expect(bridge.sample(10000).walking[0]).toBe(0);
    expect(bridge.motionDiagnostics.openLoopsClamped).toBe(1);
  });
  it('matches provider distance and exact source anchors across a five-second refresh',()=>{
    const geometry:readonly (readonly [number,number])[]=[[origin.longitude,origin.latitude],[origin.longitude,origin.latitude+.001]];
    const graph={...movement,edges:[{...movement.edges[0]!,geometry}]};
    const at=(seconds:number)=>({...entity,latitude:origin.latitude+.0003+seconds*2/111195});
    // camera-local legacy progress is deliberately wrong; a provider-metric bridge
    // must anchor the actual on-source coordinate, not trust this different metric.
    const first={...source,motion:{...source.motion,progress:.77,speedMps:2}};
    const next={...first,presentationTime:'2026-01-01T00:00:05Z'};
    const options={sourceMetric:'provider_equirectangular_111195' as const};
    const before=new ActorColumnsBridge([at(0)],graph,[first],origin,Date.UTC(2026,0,1)/1000,options);
    const after=new ActorColumnsBridge([at(5)],graph,[next],origin,Date.UTC(2026,0,1)/1000,options);
    const start=before.sample(0).previousPositions[2]!;
    const old=Array.from(before.sample(5).previousPositions),fresh=Array.from(after.sample(5).previousPositions);
    expect(Math.hypot(old[0]!-fresh[0]!,old[2]!-fresh[2]!)).toBeLessThan(.001);
    expect(Math.abs(old[2]!-start)).toBeGreaterThan(9.9);expect(Math.abs(old[2]!-start)).toBeLessThan(10.1);
    expect(before.motionDiagnostics.rejectedSourceAnchors).toBe(0);
    expect(before.motionDiagnostics.sourceMetric).toBe('provider_equirectangular_111195');
  });
  it('refuses to snap an unrelated source position onto a provider-metric corridor',()=>{
    const offroad={...entity,latitude:origin.latitude+.001};
    const bridge=new ActorColumnsBridge([offroad],movement,[source],origin,Date.UTC(2026,0,1)/1000,
      {sourceMetric:'provider_equirectangular_111195'});
    const sample=bridge.sample(500);
    expect(bridge.motionDiagnostics.rejectedSourceAnchors).toBe(1);
    expect(Array.from(sample.previousPositions)).toEqual(Array.from(sample.nextPositions));expect(sample.walking[0]).toBe(0);
  });
  it('keeps a genuinely closed source loop closed after guarded parallel displacement',()=>{
    const geometry=Array.from({length:12},(_,i)=>[origin.longitude+Math.cos(i*Math.PI/6)*.0005/Math.cos(origin.latitude*Math.PI/180),origin.latitude+Math.sin(i*Math.PI/6)*.0005] as const);
    geometry.push(geometry[0]!);
    const graph={...paired(),edges:paired().edges.map(edge=>({...edge,geometry})),routes:[{...movement.routes[0]!,traversal:'loop' as const}]};
    const bridge=new ActorColumnsBridge([entity],graph,[source],origin,Date.UTC(2026,0,1)/1000,{isPointClear:()=>true});
    expect(bridge.sidewalkPreview.derivedActors).toBe(1);expect(bridge.motionDiagnostics.openLoopsClamped).toBe(0);
    expect(bridge.sample(10000).walking[0]).toBe(1);
  });
  it('uses an explicitly identified source carriageway with clearance even without a sampled car',()=>{
    const hint={atGrade:true,geometryKind:'carriageway_centerline' as const,className:'residential'};
    const opts={roadHintsByEdgeId:new Map([['e',hint]]),isPointClear:()=>true};
    const bridge=new ActorColumnsBridge([entity],movement,[source],origin,Date.UTC(2026,0,1)/1000,opts);
    expect(Math.abs(bridge.sample(1).previousPositions[2]!)).toBeCloseTo(3.75,4);
    expect(bridge.sidewalkPreview.derivedActors).toBe(1);
    const noGuard=new ActorColumnsBridge([entity],movement,[source],origin,Date.UTC(2026,0,1)/1000,{roadHintsByEdgeId:opts.roadHintsByEdgeId});
    expect(noGuard.sidewalkPreview.derivedActors).toBe(0);
    const unknownWidth=new ActorColumnsBridge([entity],movement,[source],origin,Date.UTC(2026,0,1)/1000,{isPointClear:()=>true,roadHintsByEdgeId:new Map([['e',{atGrade:true,geometryKind:'carriageway_centerline'}]])});
    expect(unknownWidth.sidewalkPreview.derivedActors).toBe(0);
  });
  it('does not displace explicitly identified pedestrian geometry even if a lane copy exists',()=>{
    const bridge=new ActorColumnsBridge([entity],paired(),[source],origin,Date.UTC(2026,0,1)/1000,{isPointClear:()=>true,
      roadHintsByEdgeId:new Map([['e',{atGrade:true,geometryKind:'pedestrian_centerline',className:'footway'}]])});
    expect(bridge.sample(1).previousPositions[2]).toBeCloseTo(0);expect(bridge.sidewalkPreview.derivedActors).toBe(0);
  });
  it('fades a canonical once corridor to zero and remains invisible past its endpoint',()=>{
    const graph={...movement,routes:[{...movement.routes[0]!,traversal:'once' as const}]};
    const first={...source,motion:{...source.motion,progress:0}};
    const bridge=new ActorColumnsBridge([entity],graph,[first],origin,Date.UTC(2026,0,1)/1000,{onceEndpointFadeMeters:15});
    expect(bridge.sample(0).previousOpacities![0]).toBe(0);
    expect(bridge.sample(7.5).previousOpacities![0]).toBeCloseTo(.5);
    expect(bridge.sample(20).previousOpacities![0]).toBe(1);
    expect(bridge.sample(10000).previousOpacities![0]).toBe(0);expect(bridge.columns.nextOpacities![0]).toBe(0);
    expect(bridge.columns.ids[0]).toBe(entity.id);
  });
  it('starts a new once phase locally instead of interpolating an endpoint-to-start shortcut',()=>{
    const graph={...movement,routes:[{...movement.routes[0]!,traversal:'once' as const}]};
    const options={onceEndpointFadeMeters:15};
    const prior=new ActorColumnsBridge([entity],graph,[source],origin,Date.UTC(2026,0,1)/1000,options);
    const old=prior.sample(1000);expect(old.previousOpacities![0]).toBe(0);
    const restarted={...source,presentationTime:'2026-01-01T00:16:40Z',motion:{...source.motion,progress:0}};
    const next=new ActorColumnsBridge([entity],graph,[restarted],origin,Date.UTC(2026,0,1)/1000,options).sample(1000,.2);
    expect(next.ids[0]).toBe(old.ids[0]);expect(next.previousOpacities![0]).toBe(0);
    expect(next.previousPositions[0]).toBeCloseTo(0,4);
    expect(next.nextPositions[0]!-next.previousPositions[0]!).toBeCloseTo(.2,4);
  });
  it('bounds the L-corner interpolation seam with a fixed .25s horizon instead of the old 16x-scaled 4s chord',()=>{
    const geometry:readonly (readonly [number,number])[]=[[origin.longitude,origin.latitude],[origin.longitude+.001,origin.latitude],[origin.longitude+.001,origin.latitude+.0006]];
    const graph:WorldSceneMovementPayload={nodes:[],edges:[{...movement.edges[0]!,edgeKind:'lane',allowedModes:['car'],geometry,
      visualSpeedMetersPerSecond:{pedestrian:null,car:10,bicycle:null,transit:null}}],
      routes:[{routeId:'r',mode:'car',edgeIds:['e'],traversal:'once'}]};
    const car={...entity,kind:'vehicle' as const};
    const motion={...source,entityKind:'vehicle' as const,motion:{...source.motion,progress:0,speedMps:10}};
    const bridge=new ActorColumnsBridge([car],graph,[motion],origin,Date.UTC(2026,0,1)/1000);
    const start=MercatorCoordinate.fromLngLat([origin.longitude,origin.latitude]);
    const corner=MercatorCoordinate.fromLngLat([origin.longitude+.001,origin.latitude]);
    const cornerTime=Math.hypot(corner.x-start.x,corner.y-start.y)/start.meterInMercatorCoordinateUnits()/10;
    const seam=(horizon:number)=>{
      // The corner lies halfway through both source-sampled windows. Compare the
      // old GPU chord and its replacement at the SAME time, not frame displacement.
      const time=cornerTime-horizon/2,frame=bridge.sample(time,horizon);
      const p=Array.from(frame.previousPositions),q=Array.from(frame.nextPositions);
      const replacement=bridge.sample(time+horizon*.8,horizon).previousPositions;
      return Math.hypot(replacement[0]!-(p[0]!+(q[0]!-p[0]!)*.8),replacement[2]!-(p[2]!+(q[2]!-p[2]!)*.8));
    };
    const scaledHorizon=seam(4),fixedHorizon=seam(.25);
    expect(scaledHorizon).toBeGreaterThan(5);
    expect(fixedHorizon).toBeLessThan(.4);
    expect(fixedHorizon).toBeLessThan(scaledHorizon/10);
  });
});
