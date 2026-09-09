import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { MercatorCoordinate } from 'maplibre-gl';
import {
  Box3, BufferGeometry, Color, DirectionalLight, EdgesGeometry, HemisphereLight, ImageBitmapLoader,
  LessEqualCompare, LineBasicMaterial, LineSegments, Matrix4, Mesh, ACESFilmicToneMapping, Object3D,
  PCFShadowMap, PerspectiveCamera, PlaneGeometry, Ray, Raycaster, Scene, ShadowMaterial, SRGBColorSpace,
  Vector2, Vector3, WebGLRenderer, WebGLRenderTarget, MeshDepthMaterial,
} from 'three';
import { TilesRenderer } from '3d-tiles-renderer/three';
import { DownloadPriorityQueue, LRUCache, PriorityQueue, type Tile } from '3d-tiles-renderer/core';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { RendererLivingSnapshot } from '../types';
import type { AggregateRoadFlowSnapshot } from '../aggregateRoadFlow';
import { applyMapLibreCamera, ecefToLocalMatrix, localToMercatorMatrix, type GameOrigin } from './cameraAdapter';
import { GameActors, type GameActorColumns, type GameActorsUpdateOptions } from './GameActors';
import { GameRoadFlows } from './GameRoadFlows';
import type { CityVisualTileset } from './cityVisualPack';
import { fetchVerifiedAsset, type GameAssetIntegrity } from './verifiedAssetResponse';
import { gameOverviewOpacity } from './tiledGamePolicy';
import { chooseBuildingFrontier,fitBuildingFrontier, type BuildingFrontier } from './buildingFrontier';
import { GameWater, type GameWaterFeature } from './GameWater';
import { GameTexturePool, geometryResidentBytes, retainTextureAtResolution } from './GameTexturePool';
import { createGameEnvironment } from './GameLighting';
import { createCatalogAssetPolicy } from './catalogAssetPolicy';
import type { LoadedCityVisualCatalog } from './cityVisualCatalog';
import type { CanonicalBuildingPickResult } from './canonicalBuildingPicking';
import {GameVegetation,type GameVegetationFeature,type GameVegetationOptions} from './GameVegetation';
import {GameRoadSurfaces,type GameRoadSurfaceSource,type GameRoadSurfacesOptions} from './GameRoadSurfaces';
import {BuildingCacheAdmission} from './buildingCacheAdmission';
import {BuildingTileCache,buildingTileKey} from './BuildingTileCache';
import {GameLandCover,type GameLandCoverOptions} from './GameLandCover';
import {GameLandUseGround,type GameLandUseGroundOptions} from './GameLandUseGround';
import {applyGameRoofMaterial} from './gameRoofMaterial';
import {applyGameFacadeAppearance} from './gameFacadeAppearance';
import {applyGameWindowMaterial} from './gameWindowMaterial';
import {GameCourtyardGround} from './GameCourtyardGround';
import {GameBuildingContacts} from './GameBuildingContacts';
import {GameTrafficSignals,type GameTrafficSignalSnapshot} from './GameTrafficSignals';
import {createGameBuildingLodPolicy,gameLodResolution,type GameBuildingLodDiagnostics} from './gameBuildingLod';
import {GameShaderReadiness,type GameShaderPreparation} from './GameShaderReadiness';
import {GameSurfaceClient,type GameSurfaceAppliedResult} from './GameSurfaceClient';
import type {GameSurfaceJob} from './gameSurfaceProtocol';
import {prepareGameObjectShaders,releaseGameDepthMaterials} from './gameShaderPreparation';
import {GameObjectShaderReadiness} from './GameObjectShaderReadiness';
import {prepareGameEnvironment,type GameEnvironmentPreparation} from './gameEnvironmentPreparation';

export type GameQualityTier = 'low' | 'medium' | 'high';
export interface GamePick { kind: 'person' | 'vehicle' | 'building'; id: string; longitude: number; latitude: number }
export interface GameDiagnostics {
  state: 'new' | 'loading' | 'prepared' | 'rendering' | 'error' | 'context_lost' | 'disposed';
  visible: boolean;
  preparedCoverage: boolean;
  loadedCells: number;
  visibleCells: number;
  renderedVisibleTiles: number;
  renderedFrames: number;
  drawCalls: number;
  triangles: number;
  cacheBytes: number;
  cacheFull: boolean;
  loading: boolean;
  actorsState: 'disabled' | 'loading' | 'ready' | 'error';
  actorsVisible: boolean;
  pickMode: 'click-raycast';
  lastPickMs: number;
  shadowRenders: number;
  shadowReady: boolean;
  sunBucket: number;
  aggregateFlowSegments: number;
  aggregateFlowOpacity: number;
  renderedAggregateFlowSegments: number;
  error: string | null;
  surfaces?:GameSurfaceClient['diagnostics']|null;
  buildingLod?:GameBuildingLodDiagnostics|null;
  shaders?:{pending:number;queued:number;ready:number;failed:number;lastError:string|null;parallelSupported:boolean;depthMaterials:number;cachedPrograms:number;pendingObjects?:number;readyObjects?:number;environmentReady?:boolean};
}
export interface TiledGameLayerOptions {
  id?: string;
  tilesetUrl: string;
  /** Missing/unverified city metadata must not disable prepared actors and surfaces. */
  cityEnabled?: boolean;
  /** Already hash-verified by loadCityVisualPack. Supply together with assetUrls. */
  initialTileset?: CityVisualTileset;
  /** Exact metadata inventory, paired with byte/hash descriptors below. */
  assetUrls?: readonly string[];
  assetIntegrity?: readonly GameAssetIntegrity[];
  assetAliases?: readonly {fromUrl:string;toUrl:string}[];
  catalog?: LoadedCityVisualCatalog;
  qualityTier: GameQualityTier;
  origin?: GameOrigin;
  bounds?: [number, number, number, number];
  actorAssetBaseUrl?: string;
  ktx2TranscoderPath?: string;
  /** Display clock zone. Prototype Chelyabinsk uses UTC+5; not host-browser time. */
  sunUtcOffsetHours?: number;
  onReady?: (diagnostics: GameDiagnostics) => void;
  onDiagnostics?: (diagnostics: GameDiagnostics) => void;
  onSurfaceShadersReady?:()=>void;
  onPick?: (pick: GamePick) => void;
  /** The caller commits the matching native bank before displaying this frontier. */
  onFrontier?: (frontier: BuildingFrontier) => void;
}
export interface GameCell { scene: Object3D; bounds: Box3 }
interface LoadedCell extends GameCell { boundsReady: boolean; key: string; canonicalIds: readonly string[]; residentBytes:number }
interface FeatureRange { firstTriangle: number; triangleCount: number; canonicalId: string }

export function gameQualityPolicy(tier: GameQualityTier) {
  return { downloads: 2, maxTiles: tier === 'low' ? 64 : tier === 'medium' ? 128 : 192,
    maxCacheBytes: (tier === 'low' ? 96 : tier === 'medium' ? 192 : 256) * 1024 * 1024,
    // Medium planning split: 192 MiB geometry + 64 MiB auxiliaries = 256 MiB.
    // This reserve is not a hard cap on browser, driver or total GPU memory.
    auxiliaryReserveBytes: 64 * 1024 * 1024,
    errorTarget: tier === 'low' ? 14 : tier === 'medium' ? 8 : 5,
    shadowSize: tier === 'low' ? 0 : tier === 'medium' ? 1024 : 2048,
    shadowRadius: tier === 'high' ? 600 : 350 };
}

/** Fail-closed routing for verified metadata; no second root fetch or root mutation. */
export function createGameAssetPolicy(
  options: Pick<TiledGameLayerOptions, 'tilesetUrl' | 'initialTileset' | 'assetUrls' | 'assetIntegrity' | 'assetAliases'>,
  fetcher: typeof fetch = fetch,
) {
  if (!options.initialTileset && !options.assetUrls && !options.assetIntegrity) return null;
  if (!options.initialTileset || !options.assetUrls) throw new Error('Verified tileset and asset inventory must be supplied together.');
  const canonical = (value: string) => {
    const url = new URL(value, options.tilesetUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash) throw new Error('Unsupported city asset URL.');
    return url.href;
  };
  const rootUrl = canonical(options.tilesetUrl);
  if (!options.assetUrls.length || options.assetUrls.length > 128) throw new Error('Invalid city asset inventory size.');
  const allowed = new Set(options.assetUrls.map(canonical));
  if (!allowed.has(rootUrl)) throw new Error('City asset inventory must include the root tileset.');
  if (allowed.size !== options.assetUrls.length || !options.assetIntegrity
    || options.assetIntegrity.length !== allowed.size - 1) throw new Error('Incomplete city asset integrity inventory.');
  const integrity = new Map<string, GameAssetIntegrity>();
  for (const entry of options.assetIntegrity) {
    const url = canonical(entry.url);
    if (!allowed.has(url) || url === rootUrl || integrity.has(url)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 96 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid city asset integrity inventory.');
    integrity.set(url, {url, bytes: entry.bytes, sha256: entry.sha256});
  }
  const rootJson = JSON.stringify(options.initialTileset);
  if (new TextEncoder().encode(rootJson).byteLength > 256 * 1024) throw new Error('Initial tileset exceeds metadata limit.');
  const aliases=new Map<string,string>();
  for(const alias of options.assetAliases??[]){
    const from=canonical(alias.fromUrl),to=canonical(alias.toUrl);
    if(aliases.has(from)||allowed.has(from)||!integrity.has(to))throw new Error('Invalid city asset alias.');
    aliases.set(from,to);
  }
  const resolve = (value: string) => {
    const source = canonical(value),url=aliases.get(source)??source;
    if (!allowed.has(url)) throw new Error('City asset URL is absent from the verified inventory.');
    return url;
  };
  return {
    resolve,
    async fetchData(value: string, init: RequestInit = {}): Promise<Response> {
      const url = resolve(value);
      init.signal?.throwIfAborted();
      if (url === rootUrl) return new Response(rootJson, { headers: { 'content-type': 'application/json' } });
      // Redirects must not escape the exact inventory; no credential propagation.
      return fetchVerifiedAsset(integrity.get(url)!, { ...init, method: 'GET', credentials: 'omit', redirect: 'error', mode: 'cors' }, fetcher);
    },
  };
}

async function boundedImageBlob(response: Response): Promise<Blob> {
  const limit = 16 * 1024 * 1024;
  if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > limit) throw new Error('Invalid city texture response.');
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('City texture exceeds its bounded byte limit.');
      chunks.push(value as Uint8Array<ArrayBuffer>);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return new Blob(chunks, { type: response.headers.get('content-type') ?? 'image/png' });
}

/**
 * Disclosed visual summer day (June-solstice declination), not observed weather
 * or an ephemeris. Local presentation clock is independent of demographic year.
 */
export function gameSunForTime(seconds: number, origin: GameOrigin, utcOffsetHours = 5) {
  if (!Number.isFinite(seconds) || !Number.isFinite(utcOffsetHours)) throw new Error('Invalid visual sun clock.');
  const bucket = Math.floor((((seconds % 86400) + 86400) % 86400) / 900);
  const localHour = (bucket * 900 + 450) / 3600;
  const latitude = origin.latitude * Math.PI / 180;
  const declination = 23.44 * Math.PI / 180;
  const hourAngle = (localHour - utcOffsetHours + origin.longitude / 15 - 12) * Math.PI / 12;
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north = Math.cos(latitude) * Math.sin(declination) - Math.sin(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  const up = Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  const daylight = Math.min(1, Math.max(0, up / 0.18));
  return { bucket, direction: [east, up, -north] as [number, number, number], daylight };
}

/** A lighting-only catcher: unshadowed fragments are transparent, not new land. */
export function createBoundedShadowReceiver(origin: GameOrigin, bounds: readonly [number, number, number, number]) {
  if (!bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error('Invalid shadow coverage.');
  const inverse = localToMercatorMatrix(origin).invert();
  const nw = MercatorCoordinate.fromLngLat([bounds[0], bounds[3]]);
  const se = MercatorCoordinate.fromLngLat([bounds[2], bounds[1]]);
  const first = new Vector3(nw.x, nw.y, nw.z).applyMatrix4(inverse);
  const second = new Vector3(se.x, se.y, se.z).applyMatrix4(inverse);
  const geometry = new PlaneGeometry(second.x - first.x, second.z - first.z).rotateX(-Math.PI / 2);
  const material = new ShadowMaterial({ color: 0x17212b, opacity: 0.42, depthWrite: false });
  const receiver = new Mesh(geometry, material);
  receiver.name = 'game-lighting-only-shadow-receiver';
  receiver.position.set((first.x + second.x) / 2, 0.015, (first.z + second.z) / 2);
  receiver.castShadow = false; receiver.receiveShadow = true;
  receiver.userData.lightingOnly = true;
  receiver.raycast = () => {}; // Never becomes a semantic pick or click occluder.
  return receiver;
}

export function readGameTilesetMetadata(value: unknown, allowCatalog=false): { origin: GameOrigin; bounds: [number, number, number, number] | null } {
  const data = value as { root?: { content?: { uri?: string }; extras?: Record<string, unknown> }; extras?: Record<string, unknown> };
  const extras = data?.root?.extras ?? data?.extras;
  const origin = extras?.origin;
  if (extras?.coordinateSystem !== 'east-up-south' || !Array.isArray(origin) || origin.length < 2
    || !origin.every(Number.isFinite)) throw new Error('Tileset requires an explicit East/Up/South origin.');
  if (!data.root?.content?.uri && !(allowCatalog&&extras?.coverage==='catalog')) throw new Error('Tileset requires retained coarse root content.');
  const result = { longitude: origin[0] as number, latitude: origin[1] as number, altitude: (origin[2] ?? 0) as number };
  localToMercatorMatrix(result); // Validate bounds before touching rendering state.
  const bounds = extras.bounds ?? extras.bbox;
  if (bounds !== undefined && (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)
    || bounds[0] >= bounds[2] || bounds[1] >= bounds[3])) throw new Error('Invalid tileset coverage bounds.');
  return { origin: result, bounds: Array.isArray(bounds) ? bounds as [number, number, number, number] : null };
}

/** IDs refer to actual merged mesh triangles, never a GPU instance ordinal. */
export function semanticBuildingId(object: Object3D, faceIndex?: number | null): string | null {
  for (let current: Object3D | null = object; current; current = current.parent) {
    const ranges = current.userData.featureRanges as FeatureRange[] | undefined;
    if (ranges && faceIndex != null) {
      let low = 0, high = ranges.length - 1;
      while (low <= high) {
        const mid = (low + high) >>> 1, range = ranges[mid];
        if (faceIndex < range.firstTriangle) high = mid - 1;
        else if (faceIndex >= range.firstTriangle + range.triangleCount) low = mid + 1;
        else return typeof range.canonicalId === 'string' ? range.canonicalId : null;
      }
      return null;
    }
    if (typeof current.userData.canonicalId === 'string') return current.userData.canonicalId;
  }
  return null;
}

/** Click-only, bounded by loaded VISIBLE cell AABBs; non-pickable solids occlude. */
export function pickVisibleCity(ray: Ray, cells: Iterable<GameCell>, camera: PerspectiveCamera) {
  const raycaster = new Raycaster(); raycaster.ray.copy(ray); raycaster.camera = camera;
  const candidates: Object3D[] = [];
  for (const cell of cells) {
    if (!ray.intersectsBox(cell.bounds)) continue;
    cell.scene.traverseVisible((object) => { if ((object as Mesh).isMesh) candidates.push(object); });
  }
  const hit = raycaster.intersectObjects(candidates, false)[0];
  return hit ? { id: semanticBuildingId(hit.object, hit.faceIndex), distance: hit.distance, point: hit.point } : null;
}

/**
 * The only city WebGL owner. MapLibre owns canvas, camera, scheduling and fallback
 * visibility. This layer never changes a native style layer or clears its depth.
 * `ready` means prepared coarse coverage, NOT pixel/visual acceptance.
 */
export class TiledGameLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera();
  private readonly cells = new Map<Tile, LoadedCell>();
  private surfaceClient:GameSurfaceClient|null=null;
  private surfaceFailure:string|null=null;
  private shaderReadiness:GameShaderReadiness<LoadedCell>|null=null;
  private objectShaderReadiness:GameObjectShaderReadiness|null=null;
  private environmentPreparation:GameEnvironmentPreparation|null=null;
  private environmentReady=false;
  private actorAssetsReady=false;
  private readonly shaderDepthMaterials=new Map<Mesh,MeshDepthMaterial>();
  private readonly assetPolicy: ReturnType<typeof createGameAssetPolicy> | ReturnType<typeof createCatalogAssetPolicy>;
  private readonly assetAbort = new AbortController();
  private readonly sun = new DirectionalLight(0xffeed5, 2.5);
  private readonly hemisphere = new HemisphereLight(0xd5e5f0, 0xb0b096, 1.16);
  private readonly sunDirection = new Vector3(-700, 1400, 500).normalize();
  private sunBucket = -1;
  private shadowReceiver: Mesh<PlaneGeometry, ShadowMaterial> | null = null;
  private readonly focus = new Vector3(Infinity, 0, Infinity);
  private map: MapLibreMap | null = null;
  private renderer: WebGLRenderer | null = null;
  private tiles: TilesRenderer | null = null;
  private actors: GameActors | null = null;
  private flows: GameRoadFlows | null = null;
  private readonly water = new GameWater();
  private readonly vegetation=new GameVegetation();
  private readonly roadSurfaces=new GameRoadSurfaces();
  private readonly landCover=new GameLandCover();
  private readonly landUseGround=new GameLandUseGround();
  private readonly courtyardGround=new GameCourtyardGround();
  private readonly buildingContacts=new GameBuildingContacts();
  private readonly trafficSignals=new GameTrafficSignals();
  private readonly cacheAdmission:BuildingCacheAdmission|null;
  private cacheEpoch=0;
  private cacheAnchor:{longitude:number;latitude:number;zoom:number;bearing:number;pitch:number;width:number;height:number}|null=null;
  private readonly texturePool: GameTexturePool;
  private readonly environment=createGameEnvironment();
  private readonly windowDaylight={value:1};
  private readonly buildingLod:ReturnType<typeof createGameBuildingLodPolicy>;
  private candidateFrontier: BuildingFrontier | null = null;
  private committedFrontier: BuildingFrontier | null = null;
  private flowSnapshot: AggregateRoadFlowSnapshot | null = null;
  private ktx2: KTX2Loader | null = null;
  private shadowScratch: WebGLRenderTarget | null = null;
  private origin: GameOrigin;
  private coverageBounds: [number, number, number, number] | null;
  private prepared = false;
  private shadowInitialized = false;
  private readyAnnounced = false;
  private disposed = false;
  private cityFailed = false;
  private shadowDirty = true;
  private frontierAnnouncementPending = false;
  private selectionDirty = true;
  private selectedId: string | null = null;
  private highlight: LineSegments | null = null;
  private currentTime:{presentationSeconds:number;actorSeconds?:number;playing:boolean} = { presentationSeconds: 0, playing: false };
  private actorSnapshot: RendererLivingSnapshot | null = null;
  private actorOptions: GameActorsUpdateOptions = {};
  private actorColumns: GameActorColumns | null = null;
  private lastDiagnostics = 0;
  private diagnosticsValue: GameDiagnostics = {
    state: 'new', visible: false, preparedCoverage: false, loadedCells: 0, visibleCells: 0,
    renderedVisibleTiles: 0, renderedFrames: 0, drawCalls: 0, triangles: 0,
    cacheBytes: 0, cacheFull: false, loading: false, actorsState: 'disabled', actorsVisible: false,
    pickMode: 'click-raycast', lastPickMs: 0, shadowRenders: 0, shadowReady: false, sunBucket: -1, aggregateFlowSegments: 0,
    aggregateFlowOpacity:0,renderedAggregateFlowSegments:0,error: null,
  };

  constructor(private readonly options: TiledGameLayerOptions) {
    this.buildingLod=createGameBuildingLodPolicy(options.catalog?.catalogSha256);
    this.cacheAdmission=options.catalog?new BuildingCacheAdmission({maxBytes:gameQualityPolicy(options.qualityTier).maxCacheBytes,maxStaging:2}):null;
    this.texturePool=new GameTexturePool({maxBytes:(options.qualityTier==='high'?208:options.qualityTier==='medium'?56:16)*1024*1024});
    this.assetPolicy = options.cityEnabled===false?null:options.catalog?createCatalogAssetPolicy(options.catalog,options.origin!):createGameAssetPolicy(options);
    this.cityFailed=options.cityEnabled===false;
    if(this.cityFailed)this.diagnosticsValue.error='Verified visual metadata unavailable; native geometry and prepared actors retained.';
    this.id = options.id ?? 'omnitwin-tiled-game-city';
    this.origin = options.origin ?? { longitude: 61.39466, latitude: 55.1654, altitude: 0 };
    localToMercatorMatrix(this.origin);
    this.coverageBounds = options.bounds ?? null;
    this.shadowInitialized = gameQualityPolicy(options.qualityTier).shadowSize === 0;
    this.diagnosticsValue.shadowReady = this.shadowInitialized;
  }
  private get renderingAvailable():boolean{return this.prepared&&this.shadowInitialized&&!this.disposed&&!this.cityFailed&&this.diagnosticsValue.state!=='context_lost';}
  /** Readiness of the next ownership transaction, independent of the old bank. */
  get ready(): boolean { return this.renderingAvailable && Boolean(this.candidateFrontier?.tileKeys.length); }
  /** The current native bank still masks these owners until its worker swap.
   * An empty next frontier must not hide this retained, drawable geometry. */
  private get committedDrawable():boolean{
    const keys=this.committedFrontier?.tileKeys;
    if(!this.renderingAvailable||!keys?.length)return false;
    const loaded=new Set([...this.cells.values()].filter(cell=>this.shaderReadiness?.isReady(cell.key)).map(cell=>cell.key));
    return keys.every(key=>loaded.has(key));
  }
  get bounds(): [number, number, number, number] | null { return this.coverageBounds ? [...this.coverageBounds] : null; }
  get diagnostics(): GameDiagnostics {
    const tiles=this.shaderReadiness?.diagnostics??{pending:0,queued:0,ready:0,failed:0,lastError:null},objects=this.objectShaderReadiness?.diagnostics;
    return { ...this.diagnosticsValue,surfaces:this.surfaceClient?.diagnostics??null,buildingLod:this.buildingLod?{...this.buildingLod.diagnostics}:null,
      shaders:{...tiles,pending:tiles.pending+(objects?.compilingBatches??0),failed:tiles.failed+(objects?.failures??0),lastError:objects?.lastError??tiles.lastError,
        parallelSupported:this.renderer?.extensions.has('KHR_parallel_shader_compile')??false,
        depthMaterials:this.shaderDepthMaterials.size,cachedPrograms:this.renderer?.info.programs?.length??0,
        pendingObjects:objects?.pendingMeshes??0,readyObjects:objects?.readyMeshes??0,environmentReady:this.environmentReady} }; }
  get frontier(): BuildingFrontier | null { return this.candidateFrontier; }
  get displayedFrontier(): BuildingFrontier | null { return this.committedFrontier; }
  get waterDiagnostics() { return {...this.water.telemetry,shaderReady:this.objectShaderReadiness?.isReady(this.water.object)??false}; }
  get vegetationDiagnostics(){return this.vegetation.telemetry;}
  get roadSurfaceDiagnostics(){return this.roadSurfaces.telemetry;}
  get landCoverDiagnostics(){return this.landCover.telemetry;}
  get landUseGroundDiagnostics(){return this.landUseGround.telemetry;}
  get courtyardGroundDiagnostics(){return this.courtyardGround.telemetry;}
  get buildingContactDiagnostics(){return this.buildingContacts.telemetry;}
  get trafficSignalDiagnostics(){return this.trafficSignals.telemetry;}
  get memoryDiagnostics(){return {geometry:this.cacheAdmission?.diagnostics??null,textures:this.textureDiagnostics.retainedBytes,
    vegetation:this.vegetation.telemetry.retainedBytes,roads:this.roadSurfaces.telemetry.retainedBytes,landCover:this.landCover.telemetry.retainedBytes,landUseGround:this.landUseGround.telemetry.retainedBytes,
    trafficSignals:this.trafficSignals.telemetry.retainedBytes,courtyardGround:this.courtyardGround.telemetry.retainedBytes,buildingContacts:this.buildingContacts.telemetry.retainedBytes};}
  get textureDiagnostics(){return {textures:this.texturePool.count,retainedBytes:this.texturePool.bytes,resolution:this.options.qualityTier==='high'?1024:this.options.qualityTier==='medium'?512:256};}
  get catalogDiagnostics(){return this.assetPolicy&&'diagnostics' in this.assetPolicy?this.assetPolicy.diagnostics:null;}

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    if (this.disposed) throw new Error('A disposed game layer cannot be reattached.');
    if (this.renderer) throw new Error('The game layer is already attached.');
    this.map = map;
    if(this.options.catalog)this.initializeSurfaceClient();
    this.diagnosticsValue.state = this.cityFailed?'error':'loading';
    this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl, alpha: true,
      antialias: true, logarithmicDepthBuffer: false, reversedDepthBuffer: false });
    this.renderer.autoClear = false;
    this.renderer.autoClearColor = false;
    this.renderer.autoClearDepth = false;
    this.renderer.autoClearStencil = false;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.environment=null;this.scene.environmentIntensity=0.5;
    const policy = gameQualityPolicy(this.options.qualityTier);
    this.renderer.shadowMap.enabled = policy.shadowSize > 0;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.sun.castShadow = policy.shadowSize > 0;
    this.sun.shadow.mapSize.set(policy.shadowSize || 1, policy.shadowSize || 1);
    Object.assign(this.sun.shadow.camera, { left: -policy.shadowRadius, right: policy.shadowRadius,
      top: policy.shadowRadius, bottom: -policy.shadowRadius, near: 1, far: 3500 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.normalBias = 0.25;
    this.sun.shadow.bias = -0.00015;
    this.scene.add(this.hemisphere, this.sun, this.sun.target);
    this.scene.add(this.water.object);
    this.scene.add(this.vegetation.object);
    this.scene.add(this.roadSurfaces.object);
    this.scene.add(this.landCover.object);
    this.scene.add(this.landUseGround.object);
    this.scene.add(this.courtyardGround.object);
    this.scene.add(this.buildingContacts.object);
    this.scene.add(this.trafficSignals.object);
    this.resetRoadFlows();
    this.loadActors();
    this.updateShadowFocus();
    this.updateSunLighting();
    if (policy.shadowSize) this.shadowScratch = new WebGLRenderTarget(1, 1);
    this.beginEnvironmentPreparation();this.createShaderReadiness();
    const tiles = this.tiles = new TilesRenderer(this.assetPolicy&&'tilesetUrl' in this.assetPolicy?this.assetPolicy.tilesetUrl:this.options.tilesetUrl);
    if(this.buildingLod)tiles.registerPlugin(this.buildingLod);
    // The library's default per-tile estimate repeats every shared material map.
    // Geometry is admitted per tile; the bounded kit is accounted once above.
    const budgetedTiles=tiles as TilesRenderer & {calculateBytesUsed:(tile:Tile,scene:Object3D|null)=>number};
    budgetedTiles.calculateBytesUsed=(_tile,scene)=>scene?geometryResidentBytes(scene):0;
    if (this.assetPolicy) {
      const assetPolicy = this.assetPolicy;
      tiles.registerPlugin({ name: 'omnitwin-verified-root-and-asset-routing', fetchData: assetPolicy.fetchData });
      // GLTF external images/buffers bypass TilesRenderer.fetchData.
      tiles.manager.setURLModifier((url) => {
        try { return assetPolicy.resolve(url); } catch (error) { this.fail(error); throw error; }
      });
      const imageLoader = new ImageBitmapLoader(tiles.manager);
      imageLoader.load = (url, onLoad, _onProgress, onError) => {
        tiles.manager.itemStart(url);
        void assetPolicy.fetchData(url, { signal: this.assetAbort.signal })
          .then(boundedImageBlob)
          .then((blob) => createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
          .then((bitmap) => {
            if (this.disposed) { bitmap.close(); throw new DOMException('Game layer disposed.', 'AbortError'); }
            onLoad?.(bitmap);
          })
          .catch((error: unknown) => {
            // GLTFLoader swallows image errors into a null texture. Do not let
            // that silently qualify a textureless city as ready.
            if (!this.disposed) this.fail(error);
            onError?.(error); tiles.manager.itemError(url);
          })
          .finally(() => tiles.manager.itemEnd(url));
      };
      tiles.manager.addHandler(/\.(png|jpe?g|webp|avif)$/i, imageLoader);
    }
    const cache = this.cacheAdmission?new BuildingTileCache(this.cacheAdmission,policy.maxTiles):new LRUCache();
    cache.unloadPriorityCallback = tiles.lruCache.unloadPriorityCallback;
    cache.maxSize = policy.maxTiles; cache.minSize = Math.floor(policy.maxTiles * 0.65);
    cache.maxBytesSize = policy.maxCacheBytes; cache.minBytesSize = policy.maxCacheBytes * 0.7;
    cache.unloadPercent = 1; // One bounded eviction pass, not an autonomous eviction RAF chain.
    cache.autoMarkUnused = false;
    tiles.lruCache = cache;
    const downloads = new DownloadPriorityQueue();
    downloads.priorityCallback = tiles.downloadQueue.priorityCallback; downloads.maxJobsPerOrigin = policy.downloads;
    const parsing = new PriorityQueue(); parsing.priorityCallback = tiles.parseQueue.priorityCallback; parsing.maxJobs = 1;
    const nodes = new PriorityQueue(); nodes.priorityCallback = tiles.processNodeQueue.priorityCallback; nodes.maxJobs = 4;
    tiles.downloadQueue = downloads; tiles.parseQueue = parsing; tiles.processNodeQueue = nodes;
    tiles.errorTarget = policy.errorTarget; tiles.loadAncestors = true; tiles.loadSiblings = true;
    if(this.options.catalog){tiles.loadAncestors=false;tiles.loadSiblings=false;}
    tiles.fetchOptions = { mode: 'cors', credentials: 'omit' };
    tiles.group.matrixAutoUpdate = false;
    tiles.group.matrix.copy(ecefToLocalMatrix(this.origin));
    tiles.group.updateMatrixWorld(true);
    tiles.setCamera(this.camera);
    const loader = new GLTFLoader(tiles.manager);
    loader.setMeshoptDecoder(MeshoptDecoder);
    if (this.assetPolicy) loader.register((parser) => ({
      name: 'omnitwin-bounded-glb-resources',
      loadTexture:(index:number)=>{
        const definition=parser.json.textures[index],source=parser.json.images[definition.source];
        if(typeof source?.uri!=='string')return null;
        const url=this.assetPolicy!.resolve(new URL(source.uri,parser.options.path).href);
        const key=JSON.stringify([url,parser.json.samplers?.[definition.sampler]??{}]);
        return this.texturePool.acquire(key,async()=>{
          const loaded=await parser.loadTexture(index);
          const texture=retainTextureAtResolution(loaded,this.textureDiagnostics.resolution);
          texture.anisotropy=Math.min(8,this.renderer?.capabilities?.getMaxAnisotropy()??1);
          return texture;
        });
      },
      beforeRoot: async () => {
        // The compiled pack embeds binary buffers and has inventory-listed PNGs.
        // Reject alternate loader paths before they can bypass no-redirect fetch.
        if (parser.json.buffers?.some((buffer: { uri?: string }) => buffer.uri !== undefined)) {
          throw new Error('City GLBs must embed their binary buffers.');
        }
        for (const image of parser.json.images ?? []) {
          if (typeof image.uri !== 'string' || !/\.(png|jpe?g|webp)$/i.test(image.uri)) throw new Error('City GLBs require inventory-listed textures.');
          this.assetPolicy!.resolve(new URL(image.uri, parser.options.path).href);
        }
      },
    }));
    if (this.options.ktx2TranscoderPath) {
      this.ktx2 = new KTX2Loader(tiles.manager).setTranscoderPath(this.options.ktx2TranscoderPath).setWorkerLimit(1).detectSupport(this.renderer);
      loader.setKTX2Loader(this.ktx2);
    }
    tiles.manager.addHandler(/\.(gltf|glb)(\?.*)?$/i, loader);
    this.scene.add(tiles.group);
    tiles.addEventListener('load-root-tileset', ({ tileset }) => {
      if (this.disposed) return;
      try {
        const metadata = readGameTilesetMetadata(tileset,Boolean(this.options.catalog));
        if (this.options.origin && (Math.abs(metadata.origin.longitude - this.options.origin.longitude) > 1e-8
          || Math.abs(metadata.origin.latitude - this.options.origin.latitude) > 1e-8)) throw new Error('Tileset and actor origins disagree.');
        this.origin = metadata.origin; this.coverageBounds = metadata.bounds ?? this.coverageBounds;
        tiles.group.matrix.copy(ecefToLocalMatrix(this.origin)); tiles.group.updateMatrixWorld(true);
        this.resetRoadFlows();
        this.sunBucket = -1; this.updateSunLighting();
        if (this.coverageBounds && policy.shadowSize > 0 && !this.shadowReceiver) {
          this.shadowReceiver = createBoundedShadowReceiver(this.origin, this.coverageBounds);
          this.shadowReceiver.material.opacity = 0.42 * gameSunForTime(this.currentTime.presentationSeconds, this.origin, this.options.sunUtcOffsetHours).daylight;
          this.scene.add(this.shadowReceiver);
        }
        this.loadActors(); this.requestFrame();
      } catch (error) { this.fail(error); }
    });
    tiles.addEventListener('load-model', ({ scene, tile }) => {
      if (this.disposed) return;
      const key=buildingTileKey(tile),residentBytes=geometryResidentBytes(scene);
      if(this.cacheAdmission&&key&&!this.cacheAdmission.loaded(key,residentBytes)){
        tiles.lruCache.remove(tile);this.requestFrame();return;
      }
      const canonicalIds = new Set<string>();
      scene.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        const surface = mesh.userData.surfaceKind ?? mesh.userData.kind;
        for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
          applyGameRoofMaterial(material);applyGameWindowMaterial(material,this.windowDaylight);
        }
        applyGameFacadeAppearance(mesh);
        mesh.castShadow = policy.shadowSize > 0 && surface !== 'ground' && surface !== 'road' && surface !== 'water';
        mesh.receiveShadow = policy.shadowSize > 0;
        for (const range of (mesh.userData.featureRanges ?? []) as FeatureRange[]) {
          if (range.canonicalId.startsWith('openmaptiles_buildings:')) canonicalIds.add(range.canonicalId);
        }
        if (typeof mesh.userData.canonicalId === 'string' && mesh.userData.canonicalId.startsWith('openmaptiles_buildings:')) canonicalIds.add(mesh.userData.canonicalId);
      });
      const cell:LoadedCell={ scene, bounds: new Box3(), boundsReady: false,
        key: tile.content?.uri ?? `tile-${this.cells.size}`, canonicalIds: [...canonicalIds].sort(),residentBytes };
      this.cells.set(tile,cell);
      scene.visible=false;
      this.shaderReadiness?.stage(cell.key,cell);
      if (tile===tiles.root && this.options.onFrontier) {
        // The canonical bank supplies complete source coverage. Requiring every
        // sibling GLB to fit simultaneously would otherwise stall refinement.
        tiles.loadAncestors=false;tiles.loadSiblings=false;
      }
      this.shadowDirty = true; this.selectionDirty = true; this.requestFrame();
    });
    tiles.addEventListener('dispose-model', ({ tile }) => {
      const cell=this.cells.get(tile);
      this.cells.delete(tile);
      // Release resources before the freed gate slot starts another queued job.
      if(cell){releaseGameDepthMaterials(cell.scene,this.shaderDepthMaterials);this.shaderReadiness?.release(cell.key);}
      this.shadowDirty = true; this.selectionDirty = true; this.requestFrame();
    });
    tiles.addEventListener('tile-visibility-change', () => { this.shadowDirty = true; this.selectionDirty = true; this.requestFrame(); });
    tiles.addEventListener('needs-update', this.requestFrame);
    tiles.addEventListener('tiles-load-end', this.requestFrame);
    tiles.addEventListener('load-error', ({ tile, error }) => {
      if (this.disposed) return;
      if(tile&&this.cacheAdmission){const key=buildingTileKey(tile);if(key){this.cacheAdmission.reject(key);tiles.lruCache.remove(tile);}}
      if (!tile || tile === tiles.root) this.fail(error);
      else { this.diagnosticsValue.error = 'A detail cell failed; coarse coverage retained.'; this.emit(true); }
    });
    map.on('webglcontextlost', this.contextLost);
    map.on('webglcontextrestored', this.contextRestored);
    this.emit(true); this.requestFrame();
  }

  private beginEnvironmentPreparation():void{
    if(!this.renderer)return;this.environmentPreparation?.cancel();this.environmentReady=false;this.scene.environment=null;
    const job=prepareGameEnvironment(this.renderer,this.environment);this.environmentPreparation=job;
    void job.promise.then(target=>{
      if(this.disposed||this.environmentPreparation!==job||this.diagnosticsValue.state==='context_lost')return;
      this.scene.environment=target.texture;this.environmentReady=true;this.stageSurfaceShaders();this.requestFrame();this.emit(true);
    }).catch(error=>{if(!this.disposed&&this.environmentPreparation===job&&this.diagnosticsValue.state!=='context_lost')this.fail(error);});
  }
  private prepareShaderObjects(objects:readonly Object3D[],shadowModes:readonly boolean[],onCompiled:()=>void=()=>{}):GameShaderPreparation{
    let cancelled=false,child:GameShaderPreparation|null=null;
    const compile=()=>{
      if(cancelled||!this.renderer||!objects.length)throw new DOMException('Shader preparation cancelled','AbortError');
      const live=new Set<Mesh>();this.scene.traverse(object=>{if((object as Mesh).isMesh)live.add(object as Mesh);});
      for(const loaded of this.cells.values())loaded.scene.traverse(object=>{if((object as Mesh).isMesh)live.add(object as Mesh);});
      for(const [mesh,depth]of this.shaderDepthMaterials)if(!live.has(mesh)){if(mesh.customDepthMaterial===depth)mesh.customDepthMaterial=undefined;depth.dispose();this.shaderDepthMaterials.delete(mesh);}
      child=prepareGameObjectShaders({renderer:this.renderer,root:objects[0]!,extraRoots:objects.slice(1),camera:this.camera,scene:this.scene,
        scratch:this.shadowScratch,shadowModes,depthMaterials:this.shaderDepthMaterials});onCompiled();return child.promise;
    };
    if(this.environmentReady)return{promise:compile(),cancel:()=>{cancelled=true;child?.cancel();}};
    if(!this.environmentPreparation)throw Error('Environment preparation unavailable');
    return{promise:this.environmentPreparation.promise.then(compile),cancel:()=>{cancelled=true;child?.cancel();}};
  }
  /** Called after applying worker surfaces and before each render pass. Stable
   * material/layout signatures reuse ready programs despite new vertex buffers. */
  private stageSurfaceShaders():void{
    if(!this.objectShaderReadiness||this.disposed||this.diagnosticsValue.state==='context_lost')return;
    this.objectShaderReadiness.stage([this.water.object,this.vegetation.object,this.roadSurfaces.object,this.landCover.object,this.landUseGround.object,
      this.courtyardGround.object,this.buildingContacts.object,this.trafficSignals.object,...(this.actors?[this.actors.object]:[]),
      ...(this.flows?[this.flows.object]:[]),...(this.shadowReceiver?[this.shadowReceiver]:[]),...(this.highlight?[this.highlight]:[])]);
    if(this.actors&&this.actorAssetsReady)this.diagnosticsValue.actorsState=this.objectShaderReadiness.hasFailed(this.actors.object)?'error':this.objectShaderReadiness.isReady(this.actors.object)?'ready':'loading';
  }
  private createShaderReadiness():void{
    this.shaderReadiness?.dispose();
    this.objectShaderReadiness?.dispose();
    this.objectShaderReadiness=new GameObjectShaderReadiness({maxObjects:256,
      onRelease:object=>releaseGameDepthMaterials(object,this.shaderDepthMaterials),
      prepare:(objects,onCompiled)=>this.prepareShaderObjects(objects,this.renderer?.shadowMap.enabled?[false,true]:[false],onCompiled),
      onChange:()=>{
        if(this.disposed||this.diagnosticsValue.state==='context_lost')return;
        this.stageSurfaceShaders();this.options.onSurfaceShadersReady?.();this.shadowDirty=true;this.requestFrame();this.emit(true);
      }});
    this.shaderReadiness=new GameShaderReadiness<LoadedCell>({maxPending:2,maxEntries:gameQualityPolicy(this.options.qualityTier).maxTiles+2,
      prepare:cell=>this.prepareShaderObjects([cell.scene],[this.renderer?.shadowMap.enabled??false]),onChange:(key,status)=>{
        if(this.disposed||this.diagnosticsValue.state==='context_lost')return;
        if(status==='failed'){
          this.diagnosticsValue.error='A building shader failed; previous/native coverage retained: '+this.shaderReadiness?.diagnostics.lastError;
          for(const [tile,cell]of this.cells)if(cell.key===key&&!this.committedFrontier?.tileKeys.includes(key)){
            this.cacheAdmission?.reject(key);this.tiles?.lruCache.remove(tile);break;
          }
        }
        this.shadowDirty=true;this.requestFrame();this.emit(true);
      }});
    this.stageSurfaceShaders();
  }

  /** Own-target-only shadow cache preparation; never clear the shared main FBO. */
  prerender(gl: WebGL2RenderingContext, input: CustomRenderMethodInput): void {
    if (!this.renderer || !this.shadowScratch || !this.prepared || this.disposed
      || ['error', 'context_lost'].includes(this.diagnosticsValue.state)
      || (this.shadowInitialized && !this.diagnosticsValue.visible)) return;
    try {
      applyMapLibreCamera(this.camera, input, this.origin);
      this.updateShadowFocus();
      if (!this.shadowDirty) return;
      const oldFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      const oldViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
      const oldDepthRange = gl.getParameter(gl.DEPTH_RANGE) as Float32Array;
      const actorVisible = this.actors?.object.visible;
      const tileVisible = this.tiles?.group.visible;
      const flowVisible = this.flows?.object.visible;
      const receiverVisible = this.shadowReceiver?.visible;
      const highlightVisible = this.highlight?.visible;
      try {
        this.renderer.resetState();
        this.renderer.setRenderTarget(this.shadowScratch);
        gl.depthRange(0, 1);
        this.renderer.clear(true, true, false); // This 1x1 target is owned by us.
        if (this.actors) this.actors.object.visible = false;
        if (this.tiles) this.tiles.group.visible = true;
        if (this.flows) this.flows.object.visible = false;
        if (this.shadowReceiver) this.shadowReceiver.visible = true;
        if (this.highlight) this.highlight.visible = false;
        this.stageSurfaceShaders();this.objectShaderReadiness?.enforce();
        this.renderer.shadowMap.needsUpdate = true;
        this.renderer.render(this.scene, this.camera);
        if (this.sun.shadow.map?.depthTexture?.compareFunction !== LessEqualCompare) {
          throw new Error('PCF shadow cache did not produce a comparison depth texture.');
        }
        this.shadowInitialized = true; this.diagnosticsValue.shadowReady = true;
        this.shadowDirty = false; this.diagnosticsValue.shadowRenders++;
      } finally {
        if (this.actors && actorVisible !== undefined) this.actors.object.visible = actorVisible;
        if (this.tiles && tileVisible !== undefined) this.tiles.group.visible = tileVisible;
        if (this.flows && flowVisible !== undefined) this.flows.object.visible = flowVisible;
        if (this.shadowReceiver && receiverVisible !== undefined) this.shadowReceiver.visible = receiverVisible;
        if (this.highlight && highlightVisible !== undefined) this.highlight.visible = highlightVisible;
        this.renderer.resetState();
        gl.bindFramebuffer(gl.FRAMEBUFFER, oldFramebuffer);
        gl.viewport(oldViewport[0], oldViewport[1], oldViewport[2], oldViewport[3]);
        gl.depthRange(oldDepthRange[0], oldDepthRange[1]);
      }
      this.announceReady();
    } catch (error) { this.fail(error); }
  }

  render(gl: WebGL2RenderingContext, input: CustomRenderMethodInput): void {
    const renderer = this.renderer, tiles = this.tiles, map = this.map;
    if (!renderer || !tiles || !map || this.disposed || this.diagnosticsValue.state==='context_lost') return;
    try {
      applyMapLibreCamera(this.camera, input, this.origin);
      const canvas = map.getCanvas();
      const lodResolution=gameLodResolution(canvas);
      tiles.setResolution(this.camera,lodResolution.width,lodResolution.height);
      this.scene.updateMatrixWorld(true);
      this.pinFrontiers();
      if(!this.cityFailed)tiles.update();
      // Coarse content remains available under memory pressure and quick camera changes.
      if (!this.options.onFrontier && tiles.root && this.cells.has(tiles.root)) tiles.lruCache.markUsed(tiles.root);
      this.updateFrontier();
      const visible = this.visibleCells();
      if (!this.prepared && tiles.root && (this.options.catalog||this.cells.has(tiles.root)) && this.candidateFrontier?.tileKeys.length && this.coverageBounds) {
        this.prepared = true; this.diagnosticsValue.preparedCoverage = true; this.diagnosticsValue.state = 'prepared';
        // In Three 0.185 a null sampler2DShadow[] falls back to a non-comparing
        // empty texture. Bootstrap PCF in prerender before any main draw or
        // native-coverage handover, even while this layer is still hidden.
        this.announceReady();
        if (!this.shadowInitialized) this.requestFrame();
      }
      this.actors?.setTime(this.currentTime.actorSeconds??this.currentTime.presentationSeconds);
      this.actors?.updateCamera(this.camera, canvas.clientWidth, canvas.clientHeight);
      this.flows?.updateCamera(this.camera, canvas.clientWidth, canvas.clientHeight);
      if (this.selectionDirty) this.updateHighlight(visible);
      this.stageSurfaceShaders();
      const cityVisible = this.diagnosticsValue.visible && this.committedDrawable;
      const actorsVisible = this.diagnosticsValue.actorsState === 'ready';
      const flowAlpha = gameOverviewOpacity(map.getZoom?.() ?? 14);
      this.flows?.setOpacity(flowAlpha);
      const flowsVisible = flowAlpha > 0 && (this.flows?.telemetry.segments ?? 0) > 0;
      this.diagnosticsValue.aggregateFlowOpacity=flowsVisible?flowAlpha:0;
      this.diagnosticsValue.renderedAggregateFlowSegments=flowsVisible?(this.flows?.telemetry.segments??0):0;
      tiles.group.visible = cityVisible;
      if (this.actors) this.actors.object.visible = actorsVisible;
      this.diagnosticsValue.actorsVisible = actorsVisible;
      if (this.shadowReceiver) this.shadowReceiver.visible = cityVisible;
      if (this.highlight) this.highlight.visible = cityVisible;
      if (this.flows) this.flows.object.visible = flowsVisible;
      this.diagnosticsValue.loadedCells = this.cells.size;
      this.diagnosticsValue.visibleCells = visible.length;
      this.diagnosticsValue.cacheFull = this.cacheAdmission?this.cacheAdmission.diagnostics.residentBytes>=gameQualityPolicy(this.options.qualityTier).maxCacheBytes:tiles.lruCache.isFull();
      this.diagnosticsValue.cacheBytes = [...this.cells.keys()].reduce((sum, tile) => sum + tiles.lruCache.getMemoryUsage(tile), 0);
      this.diagnosticsValue.loading = tiles.downloadQueue.running || tiles.parseQueue.running || tiles.processNodeQueue.running;
      if (cityVisible || actorsVisible || flowsVisible || this.water.telemetry.polygons > 0 || this.vegetation.telemetry.instances>0 || this.roadSurfaces.telemetry.draws>0 || this.landCover.telemetry.draws>0 || this.landUseGround.telemetry.draws>0 || this.trafficSignals.telemetry.draws>0 || this.courtyardGround.telemetry.draws>0 || this.buildingContacts.telemetry.draws>0) {
        // The prototype uses the ordinary Mercator main framebuffer. Terrain/RTT
        // requires a separately tested external-framebuffer bridge, never silent redirection.
        if (gl.getParameter(gl.FRAMEBUFFER_BINDING) !== null) throw new Error('Game layer requires the MapLibre main framebuffer (terrain RTT unsupported).');
        const depthRange = gl.getParameter(gl.DEPTH_RANGE) as Float32Array;
        const shadowEnabled = renderer.shadowMap.enabled;
        try {
          renderer.resetState();
          renderer.setViewport(0, 0, canvas.width, canvas.height);
          gl.depthRange(depthRange[0], depthRange[1]);
          renderer.shadowMap.needsUpdate = false;
          // Source-road shader has no shadow inputs. Do not introduce an
          // uninitialized PCF program while the native map owns the city.
          renderer.shadowMap.enabled = cityVisible && shadowEnabled;
          this.objectShaderReadiness?.enforce();
          renderer.render(this.scene, this.camera);
        } finally {
          renderer.shadowMap.enabled = shadowEnabled;
          renderer.resetState();
          gl.depthRange(depthRange[0], depthRange[1]);
        }
        this.diagnosticsValue.renderedFrames++;
        this.diagnosticsValue.renderedVisibleTiles = cityVisible ? visible.length : 0;
        this.diagnosticsValue.drawCalls = renderer.info.render.calls;
        this.diagnosticsValue.triangles = renderer.info.render.triangles;
        if(!this.cityFailed)this.diagnosticsValue.state = 'rendering';
        if (cityVisible && this.shadowDirty && this.shadowScratch) this.requestFrame();
      } else this.diagnosticsValue.renderedVisibleTiles = 0;
      this.emit();
    } catch (error) { this.fail(error); }
  }

  setVisible(visible: boolean): void {
    if (this.diagnosticsValue.visible === visible) return;
    this.diagnosticsValue.visible = visible;
    if (!visible) this.diagnosticsValue.renderedVisibleTiles = 0;
    this.emit(true); this.requestFrame();
  }
  setTime(time: { presentationSeconds: number; actorSeconds?:number; playing: boolean }): void {
    if (!Number.isFinite(time.presentationSeconds)||time.actorSeconds!==undefined&&!Number.isFinite(time.actorSeconds)) throw new Error('Invalid game presentation time.');
    this.currentTime = { ...time }; this.actors?.setTime(time.actorSeconds??time.presentationSeconds);
    this.flows?.setTime(time.presentationSeconds);
    this.water.setTime(time.presentationSeconds);
    this.updateSunLighting();
    // Uniform-only: the shared FrameScheduler owns animation cadence/invalidation.
  }
  updateWater(features: readonly GameWaterFeature[]): void {
    const prior = this.water.telemetry.geometryUpdates;
    this.water.update(features, this.origin, this.options.qualityTier);
    this.stageSurfaceShaders();
    if (prior !== this.water.telemetry.geometryUpdates) this.requestFrame();
  }
  updateVegetation(features:readonly GameVegetationFeature[],options:Omit<GameVegetationOptions,'origin'|'qualityTier'>):void{
    const config={...options,origin:this.origin,qualityTier:this.options.qualityTier};
    this.requestSurfaces([{kind:'vegetation',features,options:config},
      {kind:'courtyardGround',options:config,previousRetainedBytes:this.courtyardGround.telemetry.retainedBytes},
      {kind:'buildingContacts',options:config,previousRetainedBytes:this.buildingContacts.telemetry.retainedBytes}]);
  }
  updateRoadSurfaces(roads:readonly GameRoadSurfaceSource[],options:Omit<GameRoadSurfacesOptions,'origin'|'qualityTier'>):void{
    this.requestSurfaces([{kind:'roads',roads,options:{...options,origin:this.origin,qualityTier:this.options.qualityTier}}]);
  }
  updateLandCover(features:readonly GameVegetationFeature[],options:Omit<GameLandCoverOptions,'origin'|'qualityTier'>&Partial<Pick<GameLandUseGroundOptions,'buildings'|'roads'|'waterFeatures'>>):void{
    const jobs:GameSurfaceJob[]=[{kind:'landCover',features,options:{...options,origin:this.origin,qualityTier:this.options.qualityTier},previousRetainedBytes:this.landCover.telemetry.retainedBytes}];
    if(options.bounds&&options.roads&&options.waterFeatures)jobs.push({kind:'landUseGround',features,
      options:{...options,bounds:options.bounds,buildings:options.buildings??null,roads:options.roads,waterFeatures:options.waterFeatures,origin:this.origin,qualityTier:this.options.qualityTier},previousRetainedBytes:this.landUseGround.telemetry.retainedBytes});
    this.requestSurfaces(jobs);
  }
  private surfaceOwner(kind:GameSurfaceJob['kind']){
    return{roads:this.roadSurfaces,landCover:this.landCover,landUseGround:this.landUseGround,
      vegetation:this.vegetation,courtyardGround:this.courtyardGround,buildingContacts:this.buildingContacts}[kind];
  }
  private initializeSurfaceClient():void{
    try{
      this.surfaceClient=new GameSurfaceClient(new Worker(new URL('./gameSurfaceWorker.ts',import.meta.url),{type:'module'}),{
        onResults:results=>this.applySurfaceResults(results),onError:(message,jobs)=>{
          this.surfaceFailure=message;
          for(const job of jobs)this.surfaceOwner(job.kind).retainFailure(message,job.options.origin);
          this.diagnosticsValue.error='Сохранены прежние покрытия: подготовка поверхностей недоступна.';this.emit(true);
        }});
    }catch{this.surfaceFailure='Surface worker unavailable';this.diagnosticsValue.error='Сохранены прежние покрытия: подготовка поверхностей недоступна.';}
  }
  private requestSurfaces(jobs:readonly GameSurfaceJob[]):void{
    if(this.disposed)return;
    for(const job of jobs){const owner=this.surfaceOwner(job.kind);
      if(this.surfaceClient&&!this.surfaceFailure)owner.retainWhilePreparing(job.options.origin);
      else owner.retainFailure(this.surfaceFailure??'Surface worker unavailable',job.options.origin);
    }
    // Errors retain the already drawn surfaces/native map. No source compiler
    // is invoked as an implicit fallback on the rendering thread.
    this.surfaceClient?.request(jobs);
  }
  private applySurfaceResults(results:readonly GameSurfaceAppliedResult[]):void{
    if(this.disposed)return;let applied=false;
    for(const {job,result} of results){
      const owner=this.surfaceOwner(job.kind);
      if(result.status==='error'){owner.retainFailure(result.message,job.options.origin);continue;}
      if(result.status==='retained'){
        owner.retainWhilePreparing(job.options.origin);
        if(result.reason==='unverified'&&(job.kind==='roads'||job.kind==='vegetation'))owner.telemetry.state='unverified_retained';
        continue;
      }
      if(result.kind==='roads'&&job.kind==='roads')this.roadSurfaces.applyPrepared(result.prepared,job.options);
      else if(result.kind==='landCover'&&job.kind==='landCover')this.landCover.applyPrepared(result.prepared,job.options);
      else if(result.kind==='landUseGround'&&job.kind==='landUseGround')this.landUseGround.applyPrepared(result.prepared,job.options);
      else if(result.kind==='vegetation'&&job.kind==='vegetation')this.vegetation.applyPrepared(result.prepared,job.options);
      else if(result.kind==='courtyardGround'&&job.kind==='courtyardGround')this.courtyardGround.applyPrepared(result.prepared,job.options);
      else if(result.kind==='buildingContacts'&&job.kind==='buildingContacts')this.buildingContacts.applyPrepared(result.prepared,job.options);
      else throw Error('Surface application kind mismatch');
      applied=true;
    }
    if(applied){this.stageSurfaceShaders();this.shadowDirty=true;this.requestFrame();}
    this.emit(true);
  }
  /** Called synchronously with the prepared native bank swap. */
  commitFrontier(frontier: BuildingFrontier | null): void {
    const loaded = new Set([...this.cells.values()].filter(cell=>this.shaderReadiness?.isReady(cell.key)).map(cell => cell.key));
    if (frontier?.tileKeys.some(key => !loaded.has(key))) throw new Error('Cannot commit an unavailable building frontier.');
    if (this.committedFrontier?.revision === frontier?.revision){this.reconcileCache();return;}
    if(this.cacheAdmission&&this.candidateFrontier){
      const candidate=this.candidateFrontier;
      const distances=new Map([...this.cells].map(([tile,cell])=>[cell.key,tile.traversal?.distanceFromCamera??Infinity]));
      const priority=[...candidate.tileKeys].sort((a,b)=>(distances.get(a)??Infinity)-(distances.get(b)??Infinity)||a.localeCompare(b));
      const rebased=this.cacheAdmission.rebaseCandidate(frontier?.tileKeys??[],priority);
      if(rebased.length!==candidate.tileKeys.length){
        const inventory=[...this.cells.values()].map(cell=>({key:cell.key,parentKey:null,canonicalIds:cell.canonicalIds,drawable:true}));
        this.candidateFrontier=chooseBuildingFrontier(inventory,rebased,'',true);
        // Announce on the next ordinary render, outside the bank's synchronous
        // commit callback; nested bank transactions would invalidate that swap.
        this.frontierAnnouncementPending=true;
      }
    }
    this.committedFrontier = frontier;
    this.reconcileCache();
    this.pinFrontiers(); this.applyFrontier();
    this.shadowDirty = true; this.selectionDirty = true; this.requestFrame();
  }
  private pinFrontiers(): void {
    const keys = new Set([...(this.committedFrontier?.tileKeys ?? []), ...(this.candidateFrontier?.tileKeys ?? [])]);
    for (const [tile, cell] of this.cells) if (keys.has(cell.key) || !this.options.onFrontier && tile === this.tiles?.root){
      // A metadata ancestor owns the child links and must live with a retained GLB.
      let current:Tile|null=tile;for(let depth=0;current&&depth<32;depth++,current=current.parent??null)this.tiles?.lruCache.markUsed(current);
    }
  }
  private reconcileCache(frontierReviewed=false):void{
    if(!this.cacheAdmission||!this.tiles||!this.map)return;
    const center=this.map.getCenter(),canvas=this.map.getCanvas();
    const camera={longitude:center.lng,latitude:center.lat,zoom:this.map.getZoom(),bearing:this.map.getBearing(),pitch:this.map.getPitch(),width:canvas.width,height:canvas.height};
    const old=this.cacheAnchor;
    const distance=old?Math.hypot((camera.longitude-old.longitude)*Math.cos(camera.latitude*Math.PI/180)*111195,(camera.latitude-old.latitude)*111195):Infinity;
    const bearing=old?Math.abs(((camera.bearing-old.bearing+540)%360)-180):Infinity;
    // Resizing changes the visible/LOD footprint even when every camera URL
    // parameter stays identical. Old exclusions cannot deny the reopened strip.
    if(!old||distance>=100||Math.abs(camera.zoom-old.zoom)>=.5||bearing>=30||Math.abs(camera.pitch-old.pitch)>=10
      ||camera.width!==old.width||camera.height!==old.height){this.cacheAnchor=camera;this.cacheEpoch++;}
    // Parsed but not shader-ready cells still occupy the same two reserved
    // staging slots. They have not yet been reviewed as drawable candidates.
    const shaderPending=Boolean(this.shaderReadiness&&(this.shaderReadiness.diagnostics.pending+this.shaderReadiness.diagnostics.queued));
    const retired=new Set(this.cacheAdmission.reconcile(this.committedFrontier?.tileKeys??[],this.candidateFrontier?.tileKeys??[],String(this.cacheEpoch),{frontierReviewed:frontierReviewed&&!shaderPending}));
    for(const [tile,cell]of this.cells)if(retired.has(cell.key))this.tiles.lruCache.remove(tile);
  }
  private updateFrontier(): void {
    const tiles = this.tiles;
    if (!tiles?.root) return;
    const inventory = [...this.cells].map(([tile, cell]) => ({ key: cell.key,
      parentKey: tile.parent ? this.cells.get(tile.parent)?.key ?? null : null,
      canonicalIds: cell.canonicalIds, drawable: this.shaderReadiness?.isReady(cell.key)===true }));
    const readyDetail=this.options.onFrontier?[...this.cells].filter(([tile,cell])=>this.shaderReadiness?.isReady(cell.key)&&tile!==tiles.root&&tile.traversal?.inFrustum
      &&(tile.parent?.traversal?.error??Infinity)>tiles.errorTarget).map(([,cell])=>cell.key):[];
    const requested=readyDetail.length?readyDetail:[...tiles.visibleTiles].flatMap(tile => {
      const cell = this.cells.get(tile); return cell ? [cell.key] : [];
    });
    // A slow replacement must not retire the matched, visible old bank merely
    // because TilesRenderer already selected its not-yet-ready child.
    const retained=this.options.onFrontier?this.shaderReadiness?.retainWhilePending([...this.cells].filter(([tile,cell])=>tile.traversal?.inFrustum&&this.committedFrontier?.tileKeys.includes(cell.key)).map(([,cell])=>cell.key))??[]:[];
    const requestedFrontier = chooseBuildingFrontier(inventory, [...requested,...retained], this.cells.get(tiles.root)?.key ?? '',Boolean(this.options.onFrontier));
    const candidate=this.options.onFrontier?fitBuildingFrontier(inventory,requestedFrontier,
      [...this.cells].map(([tile,cell])=>({key:cell.key,bytes:cell.residentBytes,distance:tile.traversal?.distanceFromCamera??Infinity})),
      gameQualityPolicy(this.options.qualityTier).maxCacheBytes):requestedFrontier;
    if (candidate.revision !== this.candidateFrontier?.revision || this.frontierAnnouncementPending) {
      this.frontierAnnouncementPending=false;
      this.candidateFrontier = candidate;
      // Mark this inventory reviewed before onFrontier can synchronously finish
      // a native-bank swap. A later bank callback must not evaluate fresh parses
      // against the preceding candidate, and rebasing sees the correct slots.
      this.reconcileCache(true);
      this.pinFrontiers();
      if (this.options.onFrontier) this.options.onFrontier(candidate);
      else this.commitFrontier(candidate);
    }
    this.reconcileCache(true);this.pinFrontiers(); this.applyFrontier();
  }
  private applyFrontier(): void {
    const keys = new Set(this.committedFrontier?.tileKeys ?? []);
    for (const cell of this.cells.values()) {
      cell.scene.visible = keys.has(cell.key)&&this.shaderReadiness?.isReady(cell.key)===true;
      // TilesRenderer detaches a replaced parent. Pinning its cache allocation
      // alone does not keep it drawable during native worker preparation.
      if (cell.scene.visible && this.tiles && !this.tiles.group.children.includes(cell.scene)) this.tiles.group.add(cell.scene);
    }
  }
  updateActors(snapshot: RendererLivingSnapshot, options: GameActorsUpdateOptions = {}): void {
    this.actorSnapshot = snapshot; this.actorColumns = null; this.actorOptions = options;
    this.actors?.update(snapshot, options);
  }
  updateActorColumns(columns: GameActorColumns, options: { selectedId?: string | null;headingEpoch?:number|string } = {}): void {
    this.actorColumns = columns; this.actorSnapshot = null; this.actorOptions = options;
    this.actors?.updateColumns(columns, options);
  }
  /** Sampled by the existing actor scheduler; lights share the controller's phase. */
  updateTrafficSignals(snapshot:GameTrafficSignalSnapshot):void { this.trafficSignals.update(snapshot); }
  setAggregateFlows(snapshot: AggregateRoadFlowSnapshot | null): void {
    if ((snapshot?.signature ?? null) === (this.flowSnapshot?.signature ?? null)) return;
    this.flowSnapshot = snapshot; this.flows?.setSnapshot(snapshot);
    this.diagnosticsValue.aggregateFlowSegments = this.flows?.telemetry.segments ?? 0;
    // Data setters may run inside scheduler.onFrame; the caller invalidates UI changes.
  }
  setActors(snapshot: RendererLivingSnapshot): void { this.updateActors(snapshot); }
  /** Bounded diagnostic of actual instanced attributes; never a renderer control. */
  readMotionProbe(ids:readonly string[]=[]){return this.actors?.readMotionProbe(ids)??null;}
  setSelectedId(id: string | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id; this.selectionDirty = true;
    this.actorOptions = { ...this.actorOptions, selectedId: id };
    if (this.actorSnapshot) this.actors?.update(this.actorSnapshot, this.actorOptions);
    if (this.actorColumns) this.actors?.updateColumns(this.actorColumns, this.actorOptions);
    this.requestFrame();
  }
  pickAt(x: number, y: number,nativePick?:(ray:Ray,origin:GameOrigin)=>CanonicalBuildingPickResult): GamePick | null {
    if (!this.map || this.disposed || this.diagnosticsValue.state === 'context_lost') return null;
    const start = performance.now(), canvas = this.map.getCanvas();
    const raycaster = new Raycaster();
    raycaster.setFromCamera(new Vector2(x / canvas.clientWidth * 2 - 1, 1 - y / canvas.clientHeight * 2), this.camera);
    const mesh = this.diagnosticsValue.visible && this.committedDrawable ? pickVisibleCity(raycaster.ray, this.visibleCells(), this.camera) : null;
    const native=nativePick?.(raycaster.ray,this.origin);
    if(native&&!native.complete)return null;
    const city=native?.hit&&(!mesh||native.hit.distance<mesh.distance)?native.hit:mesh;
    const actor = this.diagnosticsValue.actorsVisible ? this.actors?.pick(raycaster.ray) : null;
    let pick: GamePick | null = null;
    const hit = actor && (!city || actor.distance < city.distance) ? actor : city;
    if (hit?.id) {
      const mercator = hit.point.clone().applyMatrix4(localToMercatorMatrix(this.origin));
      const lonlat = new MercatorCoordinate(mercator.x, mercator.y, mercator.z).toLngLat();
      pick = { id: hit.id, kind: hit === actor ? actor.kind : 'building', longitude: lonlat.lng, latitude: lonlat.lat };
    }
    this.diagnosticsValue.lastPickMs = performance.now() - start; this.emit(true);
    if (pick) this.options.onPick?.(pick);
    return pick;
  }

  private visibleCells(): LoadedCell[] {
    const result: LoadedCell[] = [];
    const keys = new Set(this.committedFrontier?.tileKeys ?? []);
    for (const cell of this.cells.values()) {
      if (!keys.has(cell.key)) continue;
      if (!cell.boundsReady) { cell.scene.updateWorldMatrix(true, true); cell.bounds.setFromObject(cell.scene); cell.boundsReady = true; }
      result.push(cell);
    }
    return result;
  }
  private loadActors(): void {
    if (this.actors || !this.options.actorAssetBaseUrl || this.disposed) return;
    this.diagnosticsValue.actorsState = 'loading';
    this.actors = new GameActors({ origin: [this.origin.longitude, this.origin.latitude],
      tier: this.options.qualityTier === 'medium' ? 'mid' : this.options.qualityTier,
      assetBaseUrl: this.options.actorAssetBaseUrl, onDirty: this.requestFrame });
    this.scene.add(this.actors.object);
    const actors = this.actors;
    void actors.load().then(() => {
      if (this.disposed || this.actors !== actors) return;
      this.actorAssetsReady=true;
      if (this.actorSnapshot) actors.update(this.actorSnapshot, this.actorOptions);
      if (this.actorColumns) actors.updateColumns(this.actorColumns, this.actorOptions);
      actors.setLighting({ sunDirection: [this.sunDirection.x, this.sunDirection.y, this.sunDirection.z] });
      actors.setTime(this.currentTime.actorSeconds??this.currentTime.presentationSeconds);this.stageSurfaceShaders();this.emit(true);this.requestFrame();
    }).catch(() => { if (!this.disposed) { this.diagnosticsValue.actorsState = 'error'; this.emit(true); } });
  }
  private resetRoadFlows(): void {
    if (this.flows) { this.scene.remove(this.flows.object); this.flows.dispose(); }
    this.flows = new GameRoadFlows({ origin: [this.origin.longitude, this.origin.latitude] });
    this.flows.setSnapshot(this.flowSnapshot);
    this.flows.setTime(this.currentTime.presentationSeconds);
    this.scene.add(this.flows.object);
    this.diagnosticsValue.aggregateFlowSegments = this.flows.telemetry.segments;
  }
  private updateShadowFocus(): void {
    if (!this.map) return;
    const center = this.map.getCenter();
    const point = MercatorCoordinate.fromLngLat(center);
    const local = new Vector3(point.x, point.y, point.z).applyMatrix4(localToMercatorMatrix(this.origin).invert());
    if (this.focus.distanceTo(local) < gameQualityPolicy(this.options.qualityTier).shadowRadius * 0.2) return;
    this.focus.set(Math.round(local.x / 20) * 20, 0, Math.round(local.z / 20) * 20);
    this.sun.target.position.copy(this.focus);
    this.sun.position.copy(this.focus).addScaledVector(this.sunDirection, 1700);
    this.sun.updateMatrixWorld(true); this.sun.target.updateMatrixWorld(true); this.shadowDirty = true;
  }
  private updateSunLighting(): void {
    const sun = gameSunForTime(this.currentTime.presentationSeconds, this.origin, this.options.sunUtcOffsetHours);
    if (sun.bucket === this.sunBucket) return;
    this.sunBucket = sun.bucket; this.diagnosticsValue.sunBucket = sun.bucket;
    this.sunDirection.set(...sun.direction).normalize();
    this.sun.intensity = 2.8 * sun.daylight;
    this.hemisphere.intensity = 0.18 + 0.68 * sun.daylight;
    this.windowDaylight.value=sun.daylight;
    if (Number.isFinite(this.focus.x)) {
      this.sun.position.copy(this.focus).addScaledVector(this.sunDirection, 1700);
      this.sun.updateMatrixWorld(true);
    }
    if (this.shadowReceiver) this.shadowReceiver.material.opacity = 0.42 * sun.daylight;
    this.actors?.setLighting({ sunDirection: sun.direction });
    this.shadowDirty = true;
    // No repaint here: one existing scheduler frame consumes the bucket event.
  }
  private updateHighlight(cells: GameCell[]): void {
    this.selectionDirty = false;
    if (this.highlight) {
      this.scene.remove(this.highlight); this.highlight.geometry.dispose();
      (this.highlight.material as LineBasicMaterial).dispose(); this.highlight = null;
    }
    if (!this.selectedId) return;
    for (const cell of cells) {
      cell.scene.traverseVisible((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh || this.highlight) return;
        const range = (mesh.userData.featureRanges as FeatureRange[] | undefined)?.find((value) => value.canonicalId === this.selectedId);
        if (!range && mesh.userData.canonicalId !== this.selectedId) return;
        let geometry = mesh.geometry;
        if (range) {
          const subset = new BufferGeometry(); subset.setAttribute('position', geometry.getAttribute('position'));
          const index = geometry.getIndex();
          subset.setIndex(Array.from({ length: range.triangleCount * 3 }, (_, i) => index ? index.getX(range.firstTriangle * 3 + i) : range.firstTriangle * 3 + i));
          geometry = subset;
        }
        const line = new LineSegments(new EdgesGeometry(geometry, 28), new LineBasicMaterial({ color: new Color(0x09c8d8), depthTest: true, depthWrite: false }));
        line.matrixAutoUpdate = false; line.matrix.copy(mesh.matrixWorld); line.renderOrder = 20;
        this.highlight = line; this.scene.add(line);
      });
      if (this.highlight) break;
    }
  }
  private requestFrame = (): void => { if (!this.disposed) this.map?.triggerRepaint(); };
  private contextLost = (): void => {
    this.diagnosticsValue.state='context_lost';this.shaderReadiness?.dispose();this.objectShaderReadiness?.dispose();this.environmentPreparation?.cancel();this.emit(true);
  };
  private contextRestored = (): void => {
    if (this.disposed) return;
    this.shadowInitialized = this.shadowScratch === null;
    this.diagnosticsValue.shadowReady = this.shadowInitialized;
    this.readyAnnounced = false;
    this.diagnosticsValue.state = this.prepared ? 'prepared' : 'loading';
    this.beginEnvironmentPreparation();this.createShaderReadiness();for(const cell of this.cells.values())this.shaderReadiness?.stage(cell.key,cell);
    this.shadowDirty = true; this.requestFrame(); this.emit(true);
  };
  private announceReady(): void {
    if (!this.ready || this.readyAnnounced) return;
    this.readyAnnounced = true;
    this.options.onReady?.(this.diagnostics);
    this.emit(true);
  }
  private fail(error: unknown): void {
    if (this.disposed) return;
    this.cityFailed=true;
    this.diagnosticsValue.state = 'error'; this.diagnosticsValue.error = error instanceof Error ? error.message : 'Game city rendering failed.';
    this.emit(true);
  }
  private emit(force = false): void {
    const now = performance.now();
    if (force || now - this.lastDiagnostics >= 250) { this.lastDiagnostics = now; this.options.onDiagnostics?.(this.diagnostics); }
  }
  onRemove(): void { this.dispose(); }
  dispose(): void {
    this.assetAbort.abort();
    if (this.disposed) return;
    this.disposed = true;
    this.surfaceClient?.dispose();this.surfaceClient=null;
    this.shaderReadiness?.dispose();this.shaderReadiness=null;
    this.objectShaderReadiness?.dispose();this.objectShaderReadiness=null;this.environmentPreparation?.cancel();this.environmentPreparation=null;
    this.map?.off('webglcontextlost', this.contextLost); this.map?.off('webglcontextrestored', this.contextRestored);
    this.actors?.dispose(); this.actors = null;
    this.flows?.dispose(); this.flows = null; this.flowSnapshot = null;
    this.water.dispose();this.vegetation.dispose();this.roadSurfaces.dispose();this.landCover.dispose();this.landUseGround.dispose();this.courtyardGround.dispose();this.buildingContacts.dispose();this.trafficSignals.dispose(); this.candidateFrontier = null; this.committedFrontier = null;
    this.tiles?.dispose(); this.tiles = null; this.cells.clear();
    for(const depth of this.shaderDepthMaterials.values())depth.dispose();this.shaderDepthMaterials.clear();
    this.texturePool.dispose();
    this.environment.dispose();
    this.ktx2?.dispose(); this.ktx2 = null;
    this.shadowScratch?.dispose(); this.shadowScratch = null;
    this.sun.shadow.dispose();
    this.shadowReceiver?.geometry.dispose(); this.shadowReceiver?.material.dispose(); this.shadowReceiver = null;
    if (this.highlight) { this.highlight.geometry.dispose(); (this.highlight.material as LineBasicMaterial).dispose(); this.highlight = null; }
    this.renderer?.dispose(); this.renderer = null; // Never forceContextLoss: MapLibre owns it.
    this.scene.clear(); this.map = null; this.prepared = false;
    this.diagnosticsValue.state = 'disposed'; this.diagnosticsValue.preparedCoverage = false;
    this.diagnosticsValue.shadowReady = false;
    this.diagnosticsValue.renderedVisibleTiles = 0; this.emit(true);
  }
}
