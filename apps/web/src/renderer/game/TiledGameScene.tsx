import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { WorldSceneProps, WorldCamera, RendererViewportSnapshot } from '../types';
import { normalizeLocalMapStyle, applyUniversalBuildingStyle, isOwnedBuildingLayer } from '../mapStyle';
import { OPENMAPTILES_BUILDINGS_SOURCE } from '../mapProvider';
import { loadCityTilePack, applyCityTilePack } from '../cityTilePack';
import { rendererAssetUrl } from '../assetUrl';
import { FrameScheduler } from '../runtime/FrameScheduler';
import { TiledGameLayer, type GameDiagnostics, type GamePick } from './TiledGameLayer';
import {sourceGroundRoadMasks} from './GameLandUseGround';
import {GameMotionClient} from './GameMotionClient';
import { canReplaceNativeCity, NATIVE_GAME_FALLBACK_ID, tiledGameBasemapStyle } from './tiledGamePolicy';
import { CanonicalBuildingBanks } from './CanonicalBuildingBanks';
import { overviewRoads } from './overviewRoads';
import { buildAggregateRoadFlows } from '../../demo/aggregateRoadFlows';
import { loadCityVisualPack } from './cityVisualPack';
import { loadCityVisualCatalog } from './cityVisualCatalog';
import {readCityVisualActivation} from './cityVisualActivation';
import {GamePresentationClock} from './gameClock';
import {pickCanonicalBuildings} from './canonicalBuildingPicking';
import {BUILDING_PICK_LAYER_IDS,resolveRendererBuildingPick} from '../buildingSource';
import {GameSurfaceRefresh} from './GameSurfaceRefresh';
import {gamePixelRatio} from './gamePixelRatio';
import {GameFrameHistory} from './GameFrameHistory';
import './TiledGameScene.css';

const EPOCH = Date.UTC(2026,0,1)/1000;
const defaultCamera={longitude:61.39466,latitude:55.1654,zoom:17.6,pitch:55,bearing:-70};
function gameCoverageLabel(covered:boolean,ready:boolean,state:GameDiagnostics['state']):string {
  if(!covered)return 'Общий план · базовая карта';
  if(ready)return 'Игровой квартал · предварительная версия';
  if(state==='error'||state==='context_lost'||state==='disposed')return 'Базовая карта · игровой квартал недоступен';
  return 'Базовая карта · загружаем игровой квартал';
}
function cameraOf(map:maplibregl.Map):WorldCamera {
  const c=map.getCenter();return {longitude:c.lng,latitude:c.lat,zoom:map.getZoom(),pitch:map.getPitch(),bearing:map.getBearing()};
}
function viewportOf(map:maplibregl.Map):RendererViewportSnapshot {
  const b=map.getBounds(),camera=cameraOf(map),canvas=map.getCanvas();
  const bbox=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()] as const;
  return {camera,bbox,widthCss:canvas.clientWidth,heightCss:canvas.clientHeight,
    revision:[...bbox, camera.zoom,camera.pitch,camera.bearing,canvas.clientWidth,canvas.clientHeight].map(v=>v.toFixed(6)).join(':')};
}

/** Opt-in streaming backend. No legacy scene, Deck city, second canvas or second RAF. */
export default function TiledGameScene(props:WorldSceneProps & {populationDatasetId?:string}) {
  const root=useRef<HTMLDivElement>(null),container=useRef<HTMLDivElement>(null);
  const latest=useRef(props);latest.current=props;
  const runtime=useRef<{map:maplibregl.Map;layer:TiledGameLayer;scheduler:FrameScheduler;syncActors:(force?:boolean)=>void;syncOverview:()=>void;syncCoverage:()=>void;invalidateSurfaces:()=>void}|null>(null);
  const [status,setStatus]=useState('Подготавливаем базовую карту');
  const [error,setError]=useState('');
  const [trafficLimited,setTrafficLimited]=useState(false);
  const [motionDelayed,setMotionDelayed]=useState(false);
  const [motionRetained,setMotionRetained]=useState(false);
  const [contextGeneration,setContextGeneration]=useState(0);
  const tier=props.rendererQuality==='performance'?'low':props.rendererQuality==='cinematic'?'high':'medium';
  const clockInput={seconds:(props.presentationMinutes??1100)*60,playing:!props.presentationClock?.paused,
    speed:props.presentationClock?.speedMultiplier??1,seekRevision:props.presentationClock?.seekRevision??0};
  const clock=useRef<GamePresentationClock>(null!);
  if(!clock.current)clock.current=new GamePresentationClock(clockInput,performance.now());
  clock.current.update(clockInput,performance.now());

  useEffect(()=>{
    const abort=new AbortController();let map:maplibregl.Map|undefined, scheduler:FrameScheduler|undefined;
    let resize:ResizeObserver|undefined;let disposed=false;let visibilityChanged:(()=>void)|undefined;
    let banks:CanonicalBuildingBanks|undefined;
    let surfaceRefresh:GameSurfaceRefresh|undefined;
    let motionClient:GameMotionClient|undefined;
    const readSeconds=()=>clock.current.read(performance.now());
    const start=async()=>{
      maplibregl.setWorkerUrl(mapWorkerUrl);
      const [styleResponse,pack,visualPack]=await Promise.all([
        fetch(rendererAssetUrl('/map/openfreemap-liberty.json'),{signal:abort.signal}),
        loadCityTilePack({signal:abort.signal}).catch(()=>null),
        readCityVisualActivation({applicationBaseUrl:new URL(rendererAssetUrl('/'),location.origin).href,development:import.meta.env.DEV,
          populationDatasetId:latest.current.populationDatasetId??'',signal:abort.signal}).then(async activation=>{
            const pack=await loadCityVisualPack({...activation,populationDatasetId:latest.current.populationDatasetId??'',signal:abort.signal});
            if(activation.sourceDatasetVersion&&pack.manifest.source.datasetVersion!==activation.sourceDatasetVersion)throw Error('Visual activation source mismatch');
            return pack;
          })
          .catch(e=>{if(!disposed)setError(e instanceof Error?e.message:'Игровой пакет недоступен');return null;}),
      ]);
      const catalogDescriptor=visualPack?.manifest.visualCatalog;
      const visualCatalog=catalogDescriptor&&visualPack?await loadCityVisualCatalog({
        catalogUrl:new URL(catalogDescriptor.uri,visualPack.manifestUrl).href,integrity:catalogDescriptor,
        populationDatasetId:latest.current.populationDatasetId??'',sourceDatasetVersion:visualPack.manifest.source.datasetVersion,signal:abort.signal,
      }).catch(e=>{if(!disposed)setError(e instanceof Error?e.message:'Городской каталог недоступен');return null;}):null;
      if(!styleResponse.ok)throw Error('Не удалось загрузить географическую подложку');
      let style=tiledGameBasemapStyle(applyUniversalBuildingStyle(normalizeLocalMapStyle(await styleResponse.json(),location.origin),
        OPENMAPTILES_BUILDINGS_SOURCE,{qualityTier:tier==='medium'?'mid':tier,materialDetailZoom:15.5}));
      if(pack)style=applyCityTilePack(style,pack);
      if(disposed||!container.current)return;
      const c=latest.current.camera??defaultCamera;
      map=new maplibregl.Map({container:container.current,style,center:[c.longitude,c.latitude],zoom:c.zoom,pitch:c.pitch,bearing:c.bearing,
        minZoom:12,maxZoom:20,maxPitch:60,renderWorldCopies:false,fadeDuration:150,
        pixelRatio:gamePixelRatio(tier,devicePixelRatio,container.current.clientWidth,container.current.clientHeight),
        canvasContextAttributes:{antialias:true,preserveDrawingBuffer:false,powerPreference:'high-performance'},
        attributionControl:{compact:true},...(pack?{transformRequest:pack.transformRequest}:{})});
      const activeMap=map;
      let mapLoaded=false,surfaceSnapshotSignature:string|undefined;
      activeMap.addControl(new maplibregl.NavigationControl(),'bottom-right');
      const visualOrigin=visualPack?.origin??{longitude:defaultCamera.longitude,latitude:defaultCamera.latitude,altitude:0};
      let trafficContext=latest.current.trafficContextKey,trafficSeek=latest.current.presentationClock?.seekRevision??0;
      let trafficLimitedValue:boolean|undefined;
      let motionDelayedValue=false;
      let motionRetainedValue=false;
      const sourceVersion=()=>visualPack?.manifest.source.datasetVersion??latest.current.verifiedCityBuildings?.datasetVersion??'';
      let frames=0,lastTelemetry=0;
      let motionCost={bridgeBuilds:0,bridgeMaxMs:0,guardBuilds:0,guardMaxMs:0,samples:0,sampleMaxMs:0};
      let actorCounts={people:0,vehicles:0};
      let bridgeEntities:WorldSceneProps['entities'],bridgeMotion:WorldSceneProps['mobilityPresentationMovement'],bridgeRoutes:WorldSceneProps['presentationMovement'];
      let bridgeBuildings:WorldSceneProps['verifiedCityBuildings'],bridgeBounds:WorldSceneProps['verifiedCityBuildingBounds'],bridgeRoads:WorldSceneProps['gameSourceRoads'],bridgeCorridors:WorldSceneProps['gameSourceCorridors'];
      const intervals:number[]=[];let prior=0,epochPlaying=clock.current.playing;
      const frameHistory=import.meta.env.DEV?new GameFrameHistory():null;
      let syncNativeWaterVisibility=()=>{};
      const publish=(d:GameDiagnostics)=>{
        if(!root.current)return;
        root.current.dataset.gameDiagnostics=JSON.stringify(d);
        root.current.dataset.gameReady=String(layer.ready);
        root.current.dataset.gameVisible=String(d.visible);
        root.current.dataset.gameActorAssets=d.actorsState;
        root.current.dataset.gameDrawCalls=String(d.drawCalls);
        root.current.dataset.gameTriangles=String(d.triangles);
        root.current.dataset.gameCacheBytes=String(d.cacheBytes);
        if(d.error)setError(d.error);
        if(d.state==='error'||d.state==='context_lost')syncCoverage();
        root.current.dataset.gameWater=JSON.stringify(layer.waterDiagnostics);
        root.current.dataset.gameVegetation=JSON.stringify(layer.vegetationDiagnostics);
        root.current.dataset.gameRoadSurfaces=JSON.stringify(layer.roadSurfaceDiagnostics);
        root.current.dataset.gameLandCover=JSON.stringify(layer.landCoverDiagnostics);
        root.current.dataset.gameLandUseGround=JSON.stringify(layer.landUseGroundDiagnostics);
        root.current.dataset.gameCourtyardGround=JSON.stringify(layer.courtyardGroundDiagnostics);
        root.current.dataset.gameBuildingContacts=JSON.stringify(layer.buildingContactDiagnostics);
        root.current.dataset.gameMemory=JSON.stringify(layer.memoryDiagnostics);
        root.current.dataset.gameTextures=JSON.stringify(layer.textureDiagnostics);
        root.current.dataset.gameCatalog=JSON.stringify(layer.catalogDiagnostics);
        root.current.dataset.gameBuildingBanks=JSON.stringify(bankDiagnostics());
        root.current.dataset.gameFrontier=JSON.stringify(layer.displayedFrontier);
      };
      const pick=(value:GamePick)=>{
        if(value.kind==='building')latest.current.onBuildingSelect?.({canonicalId:value.id,featureId:value.id,providerId:'city-visual-pack',
          datasetVersion:sourceVersion(),layerId:layer.id,sourceLayer:null});
        else {
          const entity=latest.current.entities?.find(e=>e.id===value.id);
          if(entity)latest.current.onSelect?.({...entity,longitude:value.longitude,latitude:value.latitude});
        }
      };
      const layer=new TiledGameLayer({tilesetUrl:visualPack?.tilesetUrl??new URL('city-visual-v1/tileset.json',location.href).href,
        cityEnabled:Boolean(visualPack),initialTileset:visualPack?.tileset,assetUrls:visualPack?.assetUrls,assetIntegrity:visualPack?.assetIntegrity,
        assetAliases:visualPack?.assetAliases,
        catalog:visualCatalog??undefined,
        origin:visualOrigin,bounds:visualPack?[...visualPack.bounds]:undefined,qualityTier:tier,actorAssetBaseUrl:new URL(rendererAssetUrl('/assets/game-actors-v1/'),location.origin).href,
        onReady:()=>syncCoverage(),onFrontier:()=>syncCoverage(),onSurfaceShadersReady:()=>syncNativeWaterVisibility(),onDiagnostics:publish,onPick:pick});
      const bankDiagnostics=()=>{
        if(!banks)return null;
        const {ownershipKey,requestedOwnershipKey,...diagnostics}=banks.diagnostics;
        return {...diagnostics,sourceBuildings:banks.snapshot?.canonicalIds.size??0,sourceVersion:banks.snapshot?.datasetVersion??null,
          sourceSignature:banks.snapshot?.signature??null,coverageBounds:banks.snapshot?.coverageBounds??null,
          displayedMeshBuildings:layer.displayedFrontier?.canonicalIds.length??0};
      };
      if(import.meta.env.DEV&&root.current)Object.defineProperty(root.current,'readGameMotionProbe',{configurable:true,value:(ids?:readonly string[])=>layer.readMotionProbe(ids)});
      if(import.meta.env.DEV&&root.current)Object.defineProperty(root.current,'readGameTrafficProbe',{configurable:true,value:(ids?:readonly string[])=>{
        const frame=motionClient?.frame,probe=frame?.fullTrafficProbe??frame?.trafficProbe;if(!probe||!ids?.length)return probe??null;
        const selected=new Set(ids);return {...probe,vehicles:probe.vehicles.filter(actor=>selected.has(actor.id)),pedestrians:probe.pedestrians.filter(actor=>selected.has(actor.id))};
      }});
      if(import.meta.env.DEV&&root.current)Object.defineProperty(root.current,'readGameSignalProbe',{configurable:true,value:()=>motionClient?.frame?.signals??null});
      if(import.meta.env.DEV&&root.current)Object.defineProperty(root.current,'readGameFrameHistory',{configurable:true,value:(after?:number)=>frameHistory!.read(after)});
      if(import.meta.env.DEV&&root.current)Object.defineProperty(root.current,'readGameOwnershipProbe',{configurable:true,value:()=>{
        const snapshot=banks?.snapshot,displayed=layer.displayedFrontier,meshIds=new Set(displayed?.canonicalIds??[]);
        return {camera:cameraOf(activeMap),bounds:viewportOf(activeMap).bbox,sourceBounds:snapshot?.coverageBounds??null,
          sourceVersion:snapshot?.datasetVersion??null,sourceIds:[...snapshot?.canonicalIds??[]],
          nativeIds:[...snapshot?.canonicalIds??[]].filter(id=>!meshIds.has(id)),meshIds:[...meshIds],
          frontier:displayed,banks:bankDiagnostics(),diagnostics:layer.diagnostics};
      }});
      let overviewRevision='';
      const syncOverview=()=>{
        if(activeMap.getZoom()>=15.5){layer.setAggregateFlows(null);overviewRevision='';return;}
        if(!activeMap.isStyleLoaded())return;
        const viewport=viewportOf(activeMap);
        if(overviewRevision===viewport.revision)return;
        const layers=activeMap.getStyle().layers.filter(l=>l.type==='line'&&'source-layer' in l&&l['source-layer']==='transportation').map(l=>l.id);
        const roads=overviewRoads(activeMap.queryRenderedFeatures({layers}));
        if(!roads.length){layer.setAggregateFlows(latest.current.aggregateRoadFlows??null);return;}
        const flows=buildAggregateRoadFlows({origin:[viewport.camera.longitude,viewport.camera.latitude],viewport,roads,maxInstances:tier==='low'?256:tier==='high'?1024:768});
        layer.setAggregateFlows(flows);overviewRevision=viewport.revision;scheduler?.invalidate('data');
      };
      const syncCoverage=()=>{
        if(!banks)return;
        const p=latest.current,viewport=viewportOf(activeMap);
        const source=p.verifiedCityBuildings;
        const covers=(value:typeof source,bounds=p.verifiedCityBuildingBounds)=>value?.coverage==='complete_viewport'
          &&value.datasetVersion===sourceVersion()
          &&canReplaceNativeCity(true,value.coverageBounds??bounds??null,viewport.bbox);
        // Cell bounds extend beyond the last camera rectangle. Keep that exact
        // retained snapshot during movement and asynchronous provider refreshes.
        const snapshot=covers(source)?source??null:covers(banks.snapshot,undefined)?banks.snapshot:null;
        const frontier=layer.ready?layer.frontier:null;
        // Mesh identities come from the same verified source geometry. Only the
        // viewport's source IDs are removed; offscreen detail needs no native mask.
        const meshIds=new Set(frontier?.canonicalIds.filter(id=>snapshot?.canonicalIds.has(id))??[]);
        void banks.stage(snapshot,meshIds,commit=>{
          const canonical=commit.mode==='canonical';
          layer.commitFrontier(canonical?frontier:null);
          layer.setVisible(canonical&&Boolean(frontier?.tileKeys.length));
          if(surfaceSnapshotSignature!==banks?.snapshot?.signature){surfaceSnapshotSignature=banks?.snapshot?.signature;surfaceRefresh?.mark();}
          if(root.current){
            root.current.dataset.gameCoverage=canonical?'complete_viewport':'source_loading';
            root.current.dataset.gameMapMode=canonical?'canonical_city':'native_basemap';
            root.current.dataset.gameBuildingBanks=JSON.stringify(bankDiagnostics());
          }
          setStatus(canonical?(frontier?.tileKeys.length?(visualCatalog?.manifest.coverage.status==='partial'
            ?'Город · детальная графика доступна частично':'Город · детальные здания и дворы'):'Город · проверенная геометрия')
            :gameCoverageLabel(false,layer.ready,layer.diagnostics.state));
        }).then(committed=>{
          if(!committed&&banks?.diagnostics.fallbackPending&&!disposed){
            if(root.current){root.current.dataset.gameCoverage='retained_partial_viewport';root.current.dataset.gameMapMode='retained_canonical_city';root.current.dataset.gameBuildingBanks=JSON.stringify(bankDiagnostics());}
            setStatus('Город · часть геометрии сохранена, карта загружается');
          }
          // A retained fallback transition is already reported by coverage/status.
          // Its temporary source-readiness detail must not latch a permanent error
          // banner after the next consistent generation has committed.
        });
      };
      const readSourceFeatures=(pattern:RegExp)=>{
        const pairs=new Map(activeMap.getStyle().layers.flatMap(l=>'source' in l&&typeof l.source==='string'&&'source-layer' in l
          &&typeof l['source-layer']==='string'&&pattern.test(l['source-layer'])
          ?[[`${l.source}:${l['source-layer']}`,[l.source,l['source-layer']] as const]]:[]));
        const sourceIds=[...new Set([...pairs.values()].map(([name])=>name))];
        const features=[...pairs.values()].flatMap(([name,sourceLayer])=>activeMap.querySourceFeatures(name,{sourceLayer})
          .map(feature=>({id:feature.id,properties:feature.properties,geometry:feature.geometry,sourceLayer})));
        return {features,loading:sourceIds.some(name=>!activeMap.isSourceLoaded(name))};
      };
      syncNativeWaterVisibility=()=>{
        if(disposed||!activeMap.isStyleLoaded())return;
        const ready=layer.waterDiagnostics.polygons>0&&layer.waterDiagnostics.shaderReady;
        for(const l of activeMap.getStyle().layers)if(l.type==='fill'&&'source-layer'in l&&l['source-layer']==='water'&&l.paint?.['fill-pattern']){
          const visibility=ready?'none':'visible';
          if((activeMap.getLayoutProperty(l.id,'visibility')??'visible')!==visibility)activeMap.setLayoutProperty(l.id,'visibility',visibility);
        }
      };
      const syncWater=()=>{
        if(!activeMap.isStyleLoaded())return;
        const layers=activeMap.getStyle().layers.filter(l=>l.type==='fill'&&'source-layer' in l&&l['source-layer']==='water');
        const sources=new Set(layers.flatMap(l=>'source' in l&&typeof l.source==='string'?[l.source]:[]));
        try{
          if([...sources].some(name=>!activeMap.isSourceLoaded(name)))return;
          layer.updateWater([...sources].flatMap(source=>activeMap.querySourceFeatures(source,{sourceLayer:'water'})));
          syncNativeWaterVisibility();
          if(root.current)root.current.dataset.gameWater=JSON.stringify(layer.waterDiagnostics);
        }catch(e){if(!disposed)setError(e instanceof Error?e.message:'Сохранена предыдущая вода');}
      };
      let vegetationRevision='',roadRevision='',landCoverRevision='';
      const syncRoadSurfaces=()=>{
        if(!visualCatalog||!activeMap.isStyleLoaded())return;
        const p=latest.current,source=p.verifiedCityBuildings??banks?.snapshot??null,viewport=viewportOf(activeMap),roads=p.gameSourceRoads??[];
        const transport=readSourceFeatures(/^transportation$/);
        const bridgeFeatures=transport.features.filter(f=>(f.geometry.type==='Polygon'||f.geometry.type==='MultiPolygon')
          &&f.properties?.class==='bridge'&&(f.properties?.brunnel==='bridge'||f.properties?.bridge===true||f.properties?.bridge==='yes'));
        const revision=JSON.stringify([viewport.revision,source?.signature,roads,transport.loading,bridgeFeatures.map(f=>[f.id,f.properties,f.geometry])]);
        if(revision===roadRevision)return;roadRevision=revision;
        layer.updateRoadSurfaces(roads,{bounds:viewport.bbox,buildings:source,bridgeFeatures,loading:transport.loading});
        if(root.current)root.current.dataset.gameRoadSurfaces=JSON.stringify(layer.roadSurfaceDiagnostics);
      };
      const syncVegetation=()=>{
        if(!visualCatalog||!activeMap.isStyleLoaded())return;
        const p=latest.current,source=p.verifiedCityBuildings??banks?.snapshot??null,viewport=viewportOf(activeMap);
        const {features,loading}=readSourceFeatures(/^(landuse|landcover|park|poi)$/);
        const revision=JSON.stringify([viewport.revision,source?.signature,loading,features.map(f=>[f.id,f.sourceLayer,f.properties,f.geometry]),p.gameSourceRoads]);
        if(revision===vegetationRevision)return;vegetationRevision=revision;
        layer.updateVegetation(features,{bounds:viewport.bbox,buildings:source,roads:p.gameSourceRoads??[],
          datasetVersion:source?.datasetVersion,sourceId:'openmaptiles',loading});
        if(root.current){root.current.dataset.gameVegetation=JSON.stringify(layer.vegetationDiagnostics);root.current.dataset.gameCourtyardGround=JSON.stringify(layer.courtyardGroundDiagnostics);root.current.dataset.gameBuildingContacts=JSON.stringify(layer.buildingContactDiagnostics);}
      };
      const syncLandCover=()=>{
        if(!visualCatalog||!activeMap.isStyleLoaded())return;
        const p=latest.current,source=p.verifiedCityBuildings??banks?.snapshot??null,viewport=viewportOf(activeMap),{features,loading}=readSourceFeatures(/^(landuse|landcover|park|water|transportation)$/);
        const polygons=features.filter(f=>f.sourceLayer!=='water'&&f.sourceLayer!=='transportation'&&(f.geometry.type==='Polygon'||f.geometry.type==='MultiPolygon'));
        const waterFeatures=features.filter(f=>f.sourceLayer==='water'&&(f.geometry.type==='Polygon'||f.geometry.type==='MultiPolygon'));
        const roads=[...(p.gameSourceRoads??[]),...sourceGroundRoadMasks(features)],revision=JSON.stringify([viewport.revision,source?.signature,loading,roads,polygons.map(f=>[f.id,f.sourceLayer,f.properties,f.geometry]),waterFeatures.map(f=>[f.id,f.geometry])]);
        if(revision===landCoverRevision)return;landCoverRevision=revision;
        layer.updateLandCover(polygons,{bounds:viewport.bbox,buildings:source,roads,waterFeatures,loading,sourceId:'openmaptiles',datasetVersion:sourceVersion()});
        if(root.current){root.current.dataset.gameLandCover=JSON.stringify(layer.landCoverDiagnostics);root.current.dataset.gameLandUseGround=JSON.stringify(layer.landUseGroundDiagnostics);}
      };
      const syncActors=(force=false)=>{
        const p=latest.current;
        const seek=p.presentationClock?.seekRevision??0;
        if(!motionClient){layer.setTime({presentationSeconds:readSeconds(),playing:clock.current.playing});return;}
        if(seek!==trafficSeek||trafficContext!==p.trafficContextKey){
          motionClient.reset(readSeconds());trafficSeek=seek;trafficContext=p.trafficContextKey;
          layer.updateActorColumns({ids:[],kinds:new Uint8Array(),seeds:new Uint32Array(),previousPositions:new Float32Array(),
            nextPositions:new Float32Array(),headings:new Float32Array(),walking:new Uint8Array(),previousTime:readSeconds(),currentTime:readSeconds()+.25});
          layer.updateTrafficSignals({junctions:[]});actorCounts={people:0,vehicles:0};
        }
        if(bridgeEntities!==p.entities||bridgeMotion!==p.mobilityPresentationMovement||bridgeRoutes!==p.presentationMovement||bridgeBuildings!==p.verifiedCityBuildings||bridgeBounds!==p.verifiedCityBuildingBounds||bridgeRoads!==p.gameSourceRoads||bridgeCorridors!==p.gameSourceCorridors){
          motionClient.setSource({entities:p.entities??[],presentationMovement:p.presentationMovement??null,mobilityPresentationMovement:p.mobilityPresentationMovement??[],
            verifiedCityBuildings:p.verifiedCityBuildings??null,verifiedCityBuildingBounds:p.verifiedCityBuildingBounds??null,
            gameSourceRoads:p.gameSourceRoads??[],gameSourceCorridors:p.gameSourceCorridors??[],origin:visualOrigin,epochSeconds:EPOCH});
          bridgeEntities=p.entities;bridgeMotion=p.mobilityPresentationMovement;bridgeRoutes=p.presentationMovement;
          bridgeBuildings=p.verifiedCityBuildings;bridgeBounds=p.verifiedCityBuildingBounds;bridgeRoads=p.gameSourceRoads;bridgeCorridors=p.gameSourceCorridors;
        }
        const wall=performance.now(),seconds=readSeconds();
        const motion=motionClient.tick(wall,seconds,clock.current.playing,clock.current.speed);
        for(const frame of motion.frames){
          layer.updateActorColumns(frame.columns,{selectedId:p.selectedId,headingEpoch:JSON.stringify([trafficContext,trafficSeek])});
          layer.updateTrafficSignals(frame.signals);actorCounts=frame.diagnostics.actorCounts;motionCost=frame.cost;
          const limited=Boolean(frame.signals.diagnostics.overflow);
          if(limited!==trafficLimitedValue){trafficLimitedValue=limited;setTrafficLimited(limited);}
          if(root.current){
            root.current.dataset.gameSignals=JSON.stringify(layer.trafficSignalDiagnostics);
            root.current.dataset.gameSidewalkPreview=JSON.stringify(frame.diagnostics.sidewalk);
            root.current.dataset.gameTraffic=JSON.stringify(frame.diagnostics.traffic);
            root.current.dataset.gameVehicleLanes=JSON.stringify(frame.diagnostics.vehicleLanes);
          }
        }
        const delayed=motionClient.diagnostics.lagSeconds>.5;
        if(delayed!==motionDelayedValue){motionDelayedValue=delayed;setMotionDelayed(delayed);}
        const retained=!clock.current.playing&&motionClient.diagnostics.displayed&&motionClient.diagnostics.sourcePending;
        if(retained!==motionRetainedValue){motionRetainedValue=retained;setMotionRetained(retained);}
        layer.setTime({presentationSeconds:seconds,actorSeconds:motion.timeSeconds,playing:clock.current.playing});
      };
      try{
        motionClient=new GameMotionClient(new Worker(new URL('./gameMotionWorker.ts',import.meta.url),{type:'module'}),readSeconds(),{
          onDirty:()=>scheduler?.invalidate('data'),onError:()=>{if(!disposed)setError('Движение приостановлено: расчёт маршрутов недоступен.');}});
      }catch{
        // A blocked/unavailable Worker affects actors only. Continue preparing
        // the same buildings, surfaces and camera without running traffic on
        // the rendering thread as an implicit fallback.
        setError('Движение приостановлено: отдельный поток расчёта недоступен.');
      }
      surfaceRefresh=new GameSurfaceRefresh({setActive:active=>scheduler?.setReasonActive('data',active),
        isReady:()=>mapLoaded&&!disposed&&Boolean(activeMap.isStyleLoaded()),
        isInteracting:()=>activeMap.isMoving(),
        flush:()=>{syncOverview();syncWater();syncRoadSurfaces();syncLandCover();syncVegetation();},
        onError:e=>{if(!disposed)setError(e instanceof Error?e.message:'Сохранены предыдущие поверхности');}});
      scheduler=new FrameScheduler({repaint:()=>activeMap.triggerRepaint(),targetFramesPerSecond:tier==='low'?30:60,
        readPresentationState:()=>({presentationMinutes:readSeconds()/60,absolutePresentationSeconds:EPOCH+readSeconds(),paused:!clock.current.playing,
          baseRateSecondsPerWallSecond:1,speedMultiplier:clock.current.speed,reducedMotion:false,sceneTimeZone:'Asia/Yekaterinburg',environment:null}),
        onFrame:frame=>{syncActors();surfaceRefresh?.frame(frame.nowMs);}});
      runtime.current={map:activeMap,layer,scheduler,syncActors,syncOverview,syncCoverage,invalidateSurfaces:()=>surfaceRefresh?.mark()};
      visibilityChanged=()=>scheduler?.setVisible(!document.hidden);
      document.addEventListener('visibilitychange',visibilityChanged);visibilityChanged();
      const publishCamera=()=>{
        const viewport=viewportOf(activeMap);
        latest.current.onViewportChange?.(viewport);latest.current.onCameraChange?.(viewport.camera);overviewRevision='';syncCoverage();surfaceRefresh?.mark();
      };
      activeMap.on('load',()=>{
        mapLoaded=true;
        const before=activeMap.getStyle().layers.find(l=>l.type==='symbol')?.id;
        const buildingLayers=activeMap.getStyle().layers.filter(l=>isOwnedBuildingLayer(l.id)||l.id===NATIVE_GAME_FALLBACK_ID);
        banks=new CanonicalBuildingBanks(activeMap,{layerTemplates:buildingLayers,fallbackLayerIds:buildingLayers.map(l=>l.id),beforeLayerId:layer.id,keepFallbackPrepared:true});
        activeMap.addLayer(layer,before);layer.setAggregateFlows(latest.current.aggregateRoadFlows??null);syncActors();publishCamera();
        scheduler?.setReasonActive('timeline',clock.current.playing);
        latest.current.onSourceStateChange?.('online');
      });
      activeMap.on('moveend',publishCamera);
      activeMap.on('move',()=>{
        surfaceRefresh?.mark();
        // Never display a bounded canonical source outside its proven extent.
        // The bank also checks native source success before a synchronous swap;
        // failed native requests keep the exact overlapping geometry retained.
        const bounds=banks?.snapshot?.coverageBounds;
        if(bounds&&!canReplaceNativeCity(true,bounds,viewportOf(activeMap).bbox))syncCoverage();
      });
      activeMap.on('click',event=>{
        const ids=banks?.layerIds??[];
        if(!banks?.sourceId){
          const layers=BUILDING_PICK_LAYER_IDS.filter(id=>activeMap.getLayer(id));
          const features=layers.length?activeMap.queryRenderedFeatures(event.point,{layers:[...layers]}):[];
          if(features.length){
            // Keep the basemap's own exact identity rules, including rejection
            // of aggregated features; never make up a canonical building ID.
            const selected=resolveRendererBuildingPick(OPENMAPTILES_BUILDINGS_SOURCE,features);
            if(selected)latest.current.onBuildingSelect?.(selected);
            return;
          }
          layer.pickAt(event.point.x,event.point.y);return;
        }
        const features=activeMap.queryRenderedFeatures(event.point,{layers:[...ids]});
        layer.pickAt(event.point.x,event.point.y,(ray,origin)=>pickCanonicalBuildings({ray,origin,zoom:activeMap.getZoom(),
          snapshot:banks!.snapshot,sourceId:banks!.sourceId,layerIds:ids,features}));
      });
      activeMap.on('render',()=>{
        const now=performance.now();frames++;
        frameHistory?.record(now);
        if(epochPlaying!==clock.current.playing){intervals.length=0;prior=0;epochPlaying=clock.current.playing;}
        if(clock.current.playing){if(prior)intervals.push(now-prior);prior=now;if(intervals.length>300)intervals.shift();}
        scheduler?.recordRender(now);
        if(root.current){
          const data=root.current.dataset;data.deckRenderedFrames=String(frames);data.gameFrames=String(frames);
          data.gameSurfaceRefresh=JSON.stringify(surfaceRefresh?.telemetry);
          if(now-lastTelemetry>500||!clock.current.playing){
            lastTelemetry=now;data.mapTilesLoaded=String(activeMap.areTilesLoaded());
            data.deckPedestrians=String(layer.diagnostics.actorsVisible?actorCounts.people:0);data.deckVehicles=String(layer.diagnostics.actorsVisible?actorCounts.vehicles:0);
            data.deckAggregateRoadFlows=String(layer.diagnostics.renderedAggregateFlowSegments);data.gameFrameIntervals=JSON.stringify(intervals);
            data.gamePlaying=String(clock.current.playing);data.gameMeasurement='contaminated_diagnostic';
            data.gameMotionCost=JSON.stringify(motionCost);
            data.gameMotionWorker=JSON.stringify(motionClient?.diagnostics);
            data.drawingBuffer=`${activeMap.getCanvas().width}x${activeMap.getCanvas().height}`;
          }
        }
      });
      activeMap.on('sourcedata',event=>{
        if(banks?.noteNativeSourceData(event))syncCoverage();
        if(event.sourceDataType&&event.sourceDataType!=='content'&&event.sourceDataType!=='metadata')return;
        const relevant=activeMap.getStyle()?.layers.some(l=>'source' in l&&l.source===event.sourceId&&'source-layer' in l
          &&/^(water|transportation|landuse|landcover|park|poi)$/.test(l['source-layer']??''));
        if(relevant)surfaceRefresh?.mark();
      });
      activeMap.on('idle',()=>{if(root.current)root.current.dataset.mapIdle='true';});
      activeMap.on('movestart',()=>{if(root.current)root.current.dataset.mapIdle='false';});
      activeMap.on('error',event=>{if(!disposed)setError(event.error?.message??'Ошибка картографического ресурса');});
      let restoring=false;
      activeMap.on('webglcontextlost',()=>{
        if(disposed)return;
        setStatus('Восстанавливаем графику');
        if(root.current){root.current.dataset.deckPedestrians='0';root.current.dataset.deckVehicles='0';root.current.dataset.gameVisible='false';}
      });
      activeMap.on('webglcontextrestored',()=>{
        if(disposed||restoring)return;restoring=true;
        // MapLibre disposes custom layers during context reconstruction. Rebuild
        // the owned map/layer pair; React retains the camera, clock and selection.
        setError('');setStatus('Восстанавливаем графику');setContextGeneration(value=>value+1);
      });
      resize=new ResizeObserver(()=>{
        const element=container.current;if(!element)return;
        const ratio=gamePixelRatio(tier,devicePixelRatio,element.clientWidth,element.clientHeight);
        if(activeMap.getPixelRatio()!==ratio)activeMap.setPixelRatio(ratio);else activeMap.resize();
        surfaceRefresh?.mark();if(activeMap.loaded())publishCamera();
      });resize.observe(container.current);
    };
    start().catch(e=>{if(!disposed){setStatus(map?'Базовая карта · игровой квартал недоступен':'Не удалось загрузить базовую карту');setError(e instanceof Error?e.message:String(e));latest.current.onSourceStateChange?.('online_degraded');}});
    return ()=>{disposed=true;abort.abort();motionClient?.dispose();if(visibilityChanged)document.removeEventListener('visibilitychange',visibilityChanged);resize?.disconnect();surfaceRefresh?.dispose();scheduler?.dispose();banks?.dispose();runtime.current=null;map?.remove();};
  },[tier,props.populationDatasetId,contextGeneration]);

  useEffect(()=>{const r=runtime.current;if(!r)return;r.syncActors(true);r.scheduler.setReasonActive('timeline',!props.presentationClock?.paused);if(props.presentationClock?.paused)r.scheduler.invalidate('data');},
    [props.entities,props.presentationMovement,props.mobilityPresentationMovement,props.verifiedCityBuildings,props.verifiedCityBuildingBounds,props.gameSourceRoads,props.gameSourceCorridors,props.trafficContextKey,props.presentationClock?.seekRevision,props.presentationClock?.paused,props.presentationClock?.speedMultiplier]);
  useEffect(()=>{runtime.current?.layer.setSelectedId(props.highlightedBuildingId??props.selectedId??null);},[props.highlightedBuildingId,props.selectedId]);
  useEffect(()=>{runtime.current?.syncCoverage();},[props.verifiedCityBuildings,props.verifiedCityBuildingBounds]);
  useEffect(()=>{runtime.current?.invalidateSurfaces();},[props.verifiedCityBuildings,props.verifiedCityBuildingBounds,props.gameSourceRoads]);
  useEffect(()=>{const r=runtime.current;if(r){r.syncOverview();if(props.presentationClock?.paused)r.scheduler.invalidate('data');}},[props.aggregateRoadFlows]);
  useEffect(()=>{if(props.presentationClock?.paused){runtime.current?.syncActors();runtime.current?.scheduler.invalidate('timeline');}},[props.presentationMinutes]);
  useEffect(()=>{
    const r=runtime.current,c=props.camera;if(!r||!c||r.map.isMoving())return;
    const current=cameraOf(r.map);
    if(Math.abs(current.longitude-c.longitude)>1e-6||Math.abs(current.latitude-c.latitude)>1e-6||Math.abs(current.zoom-c.zoom)>1e-3
      ||Math.abs(current.pitch-c.pitch)>0.1||Math.abs(current.bearing-c.bearing)>0.1){r.map.jumpTo({center:[c.longitude,c.latitude],zoom:c.zoom,pitch:c.pitch,bearing:c.bearing});}
  },[props.camera]);
  return <div ref={root} className="ot-world-scene" data-testid="world-canvas" data-city-graphics="tiled_game" data-renderer-mode="universal_lowpoly">
    <div ref={container} style={{position:'absolute',inset:0}} />
    <div className="ot-game-status" role="status" aria-live="polite">{status}</div>
    {error?<div role="status" style={{position:'absolute',top:48,left:12,maxWidth:480,padding:8,background:'#42331de6',color:'#ffdfab',fontSize:11}}>{error}</div>:null}
    {trafficLimited?<div role="status" style={{position:'absolute',top:error?96:48,left:12,maxWidth:480,padding:8,background:'#42331de6',color:'#ffdfab',fontSize:11}}>Движение временно ограничено. Приблизьте карту для отображения перекрёстков.</div>:null}
    {motionDelayed&&!error&&!trafficLimited?<div role="status" style={{position:'absolute',top:48,left:12,maxWidth:480,padding:8,background:'#42331de6',color:'#ffdfab',fontSize:11}}>Движение отстаёт от времени: ожидаем расчёт безопасных маршрутов.</div>:null}
    {motionRetained&&!motionDelayed&&!error&&!trafficLimited?<div role="status" style={{position:'absolute',top:48,left:12,maxWidth:480,padding:8,background:'#42331de6',color:'#ffdfab',fontSize:11}}>На паузе сохранены участники движения. Новые маршруты появятся при продолжении времени.</div>:null}
  </div>;
}
