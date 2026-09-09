import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Vector3 } from 'three';
import { localToMercatorMatrix } from '../renderer/game/cameraAdapter';
import { TiledGameLayer } from '../renderer/game/TiledGameLayer';
import { BuildingCacheAdmission } from '../renderer/game/buildingCacheAdmission';
import { BuildingTileCache } from '../renderer/game/BuildingTileCache';
import type { AggregateRoadFlowSnapshot } from '../renderer/aggregateRoadFlow';
import type { CityVisualTileset } from '../renderer/game/cityVisualPack';
import {GameSurfaceWorkerCore} from '../renderer/game/GameSurfaceWorkerCore';
import {gameSurfaceTransferables} from '../renderer/game/gameSurfaceProtocol';

const harness = vi.hoisted(() => ({ renderers: [] as any[], tiles: [] as any[] }));
vi.mock('three', async (original) => {
  const three = await original<typeof import('three')>();
  return { ...three, WebGLRenderer: class {
    shadowMap = { enabled: false, autoUpdate: true, needsUpdate: false, type: 0 };
    info = { render: { calls: 3, triangles: 12 } };
    extensions={has:()=>true};
    target: unknown = null;
    resets = 0;
    renders: unknown[] = [];
    drawnNames: string[][] = [];
    clears: unknown[] = [];
    disposed = false;
    programs=new WeakMap<object,Map<string,unknown>>();
    properties={get:(material:object)=>({programs:this.programs.get(material)})};
    constructor(readonly options: unknown) { harness.renderers.push(this); }
    getContext(){return (this.options as {context:unknown}).context;}
    getRenderTarget(){return this.target;}
    compile(root:import('three').Object3D){const materials=new Set<import('three').Material>();root.traverse(object=>{
      const mesh=object as import('three').Mesh;if(!mesh.isMesh)return;
      for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){materials.add(material);
        if(!this.programs.has(material))this.programs.set(material,new Map([['fixture',{program:{},isReady:()=>true,getUniforms:vi.fn(),getAttributes:vi.fn()}]]));}
    });return materials;}
    resetState() { this.target = null; this.resets++; }
    setRenderTarget(target: unknown) { this.target = target; }
    setViewport() {}
    render(scene: import('three').Scene) {
      const sun = scene.children.find((object) => (object as import('three').DirectionalLight).isDirectionalLight) as import('three').DirectionalLight | undefined;
      if (sun?.castShadow && this.shadowMap.enabled && this.shadowMap.needsUpdate) {
        sun.shadow.map ??= new three.WebGLRenderTarget(1, 1);
        sun.shadow.map.depthTexture ??= new three.DepthTexture(1, 1);
        sun.shadow.map.depthTexture.compareFunction = three.LessEqualCompare;
      }
      if (this.target === null && sun?.castShadow && this.shadowMap.enabled && !sun.shadow.map?.depthTexture?.compareFunction) {
        throw new Error('PCF shadow sampler would receive an uninitialized texture.');
      }
      const names: string[] = []; scene.traverseVisible((object) => { if ((object as import('three').Mesh).isMesh) names.push(object.name); });
      this.drawnNames.push(names);
      this.renders.push(this.target);
    }
    clear() { this.clears.push(this.target); }
    dispose() { this.disposed = true; }
  }, PMREMGenerator:class {
    _ggxMaterial=new three.MeshBasicMaterial();_equirectMaterial=new three.MeshBasicMaterial();
    _lodMeshes=[new three.Mesh(new three.BoxGeometry(1,1,1))];
    _setSize(){} _allocateTargets(){return new three.WebGLRenderTarget(1,1);}
    compileEquirectangularShader(){} fromEquirectangular(_source:unknown,target:unknown){return target;}
    dispose(){this._ggxMaterial.dispose();this._equirectMaterial.dispose();this._lodMeshes[0].geometry.dispose();}
  } };
});
vi.mock('3d-tiles-renderer/three', async () => {
  const { Group } = await import('three');
  return { TilesRenderer: class {
    root: any = null;
    group = new Group(); visibleTiles = new Set();
    manager = { addHandler: vi.fn(), setURLModifier: vi.fn() };
    registerPlugin = vi.fn();
    lruCache = { unloadPriorityCallback: () => 0 };
    downloadQueue = { priorityCallback: () => 0 };
    parseQueue = { priorityCallback: () => 0 };
    processNodeQueue = { priorityCallback: () => 0 };
    listeners = new Map<string, ((event: any) => void)[]>();
    update = vi.fn(); dispose = vi.fn(); setCamera = vi.fn(); setResolution = vi.fn();
    constructor() { harness.tiles.push(this); }
    addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
    emit(type: string, event: unknown) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  } };
});

const origin = { longitude: 61.39466, latitude: 55.1654, altitude: 0 };
function makeMap() {
  const canvas = { width: 1200, height: 800, clientWidth: 600, clientHeight: 400 };
  return { getCanvas: () => canvas, getCenter: () => ({ lng: origin.longitude, lat: origin.latitude }),
    triggerRepaint: vi.fn(), on: vi.fn(), off: vi.fn() };
}
function makeGl() {
  return { FRAMEBUFFER_BINDING: 1, FRAMEBUFFER: 2, VIEWPORT: 3, DEPTH_RANGE: 4, LINK_STATUS:5,
    isContextLost:()=>false,getProgramParameter:()=>true,
    getParameter: (parameter: number) => parameter === 3 ? new Int32Array([0, 0, 1200, 800])
      : parameter === 4 ? new Float32Array([0, 0.999]) : null,
    bindFramebuffer: vi.fn(), viewport: vi.fn(), depthRange: vi.fn() };
}
// Keep actual shader readiness promises/timers and structured-clone worker
// delivery. These fakes replace WebGL/Worker ports, not the readiness gates.
class SurfaceWorkerPort {
  private core=new GameSurfaceWorkerCore();private closed=false;
  private listeners=new Map<string,Set<(event:any)=>void>>();
  addEventListener(type:string,fn:(event:any)=>void){const set=this.listeners.get(type)??new Set();set.add(fn);this.listeners.set(type,set);}
  removeEventListener(type:string,fn:(event:any)=>void){this.listeners.get(type)?.delete(fn);}
  postMessage(message:unknown){const copied=structuredClone(message);void Promise.resolve().then(()=>{
    if(this.closed)return;const prepared=this.core.handle(copied),data=structuredClone(prepared,{transfer:gameSurfaceTransferables(prepared)});
    for(const callback of this.listeners.get('message')??[])callback({data});
  });}
  terminate(){this.closed=true;this.listeners.clear();}
}
async function flushPreparation(){await vi.runAllTimersAsync();}
function input() {
  const camera = new PerspectiveCamera(45, 1.5, 1, 5000);
  camera.position.set(100, 500, 200); camera.lookAt(new Vector3()); camera.updateMatrixWorld(true);
  return { projectionMatrix: camera.projectionMatrix.elements, nearZ: 1, farZ: 5000, fov: Math.PI / 4,
    defaultProjectionData: { mainMatrix: camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse).multiply(localToMercatorMatrix(origin).invert()).elements,
      projectionTransition: 0 } } as unknown as CustomRenderMethodInput;
}
async function loadCoarse() {
  const tiles = harness.tiles[0];
  tiles.root = { content: { uri: 'coarse.glb' }, extras: { origin: [origin.longitude, origin.latitude, 0],
    coordinateSystem: 'east-up-south', bounds: [61.38, 55.15, 61.41, 55.18] } };
  tiles.emit('load-root-tileset', { tileset: { root: tiles.root } });
  const scene = new Group(); scene.add(new Mesh(new BoxGeometry(2, 8, 2), new MeshBasicMaterial()));
  tiles.group.add(scene); tiles.visibleTiles.add(tiles.root);
  tiles.emit('load-model', { tile: tiles.root, scene });
  await flushPreparation();
  return tiles;
}

describe('game layer shared-context lifecycle (contract tests, not pixel evidence)', () => {
  beforeEach(() => { harness.renderers.length = 0; harness.tiles.length = 0;vi.useFakeTimers();vi.stubGlobal('Worker',SurfaceWorkerPort); });
  afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
  it('retries released detail after a desktop/mobile viewport resize at the same camera',async()=>{
    const map={...makeMap(),getZoom:()=>18.25,getBearing:()=>-35,getPitch:()=>55},gl=makeGl();
    const layer=new TiledGameLayer({tilesetUrl:'https://example.org/tileset.json',qualityTier:'low',onFrontier:vi.fn()});
    layer.onAdd(map as unknown as MapLibreMap,gl as unknown as WebGL2RenderingContext); await flushPreparation();
    const admission=new BuildingCacheAdmission({maxBytes:2_000_000,maxStaging:2});
    (layer as any).cacheAdmission=admission;
    (layer as any).reconcileCache(true);
    expect(admission.admit('foreground.glb')).toBe(true);admission.loaded('foreground.glb',1000);
    admission.reject('foreground.glb','capacity');admission.release('foreground.glb');
    (layer as any).reconcileCache(true);expect(admission.admit('foreground.glb')).toBe(false);
    // The camera URL is identical, but the newly exposed strip needs detail again.
    const canvas=map.getCanvas();canvas.width=780;canvas.height=1688;canvas.clientWidth=390;canvas.clientHeight=844;
    (layer as any).reconcileCache(true);expect(admission.admit('foreground.glb')).toBe(true);
    admission.loaded('foreground.glb',1000);admission.reject('foreground.glb','capacity');admission.release('foreground.glb');
    (layer as any).reconcileCache(true);expect(admission.admit('foreground.glb')).toBe(false);
    canvas.width=1200;canvas.height=800;canvas.clientWidth=600;canvas.clientHeight=400;
    (layer as any).reconcileCache(true);expect(admission.admit('foreground.glb')).toBe(true);
    layer.dispose();
  });
  it('atomically returns four detailed owners to native coverage without exceeding staging or losing the next frontier announcement',async()=>{
    const map={...makeMap(),getZoom:()=>18,getBearing:()=>0,getPitch:()=>45},gl=makeGl(),onFrontier=vi.fn();
    const layer=new TiledGameLayer({tilesetUrl:'https://example.org/tileset.json',qualityTier:'low',onFrontier});
    layer.onAdd(map as unknown as MapLibreMap,gl as unknown as WebGL2RenderingContext); await flushPreparation();
    const admission=new BuildingCacheAdmission({maxBytes:2_000_000,maxStaging:2}),tiles=harness.tiles[0];
    (layer as any).cacheAdmission=admission;tiles.lruCache=new BuildingTileCache(admission,64);
    tiles.root={content:{uri:'root.glb'},extras:{origin:[origin.longitude,origin.latitude,0],coordinateSystem:'east-up-south',bounds:[61.38,55.15,61.41,55.18]}};
    tiles.emit('load-root-tileset',{tileset:{root:tiles.root}});
    for(let i=0;i<4;i++){
      const tile={parent:tiles.root,content:{uri:`${i}.glb`},traversal:{inFrustum:true,distanceFromCamera:i+1}},scene=new Group();
      const body=new Mesh(new BoxGeometry(2,8,2),new MeshBasicMaterial());body.userData.canonicalId=`openmaptiles_buildings:${i}`;scene.add(body);
      tiles.lruCache.add(tile,()=>{tiles.visibleTiles.delete(tile);tiles.group.remove(scene);tiles.emit('dispose-model',{tile});});
      tiles.group.add(scene);tiles.visibleTiles.add(tile);tiles.emit('load-model',{tile,scene});await flushPreparation();
      layer.render(gl as unknown as WebGL2RenderingContext,input());layer.commitFrontier(layer.frontier);
    }
    expect(layer.displayedFrontier?.tileKeys).toHaveLength(4);onFrontier.mockClear();
    expect(()=>layer.commitFrontier(null)).not.toThrow();
    expect(layer.displayedFrontier).toBeNull();expect(admission.diagnostics.staging).toBe(2);
    expect(layer.frontier?.tileKeys).toEqual(['0.glb','1.glb']);
    layer.render(gl as unknown as WebGL2RenderingContext,input());
    expect(onFrontier).toHaveBeenCalledWith(expect.objectContaining({tileKeys:['0.glb','1.glb']}));
    expect(layer.diagnostics.error).toBeNull();layer.dispose();
  });
  it('draws metric source roads independently of detailed building readiness and disposes their buffers',async()=>{
    const map=makeMap(),gl=makeGl(),bounds=[61.39,55.16,61.40,55.17] as const;
    const layer=new TiledGameLayer({tilesetUrl:'https://example.org/unverified.json',qualityTier:'low',cityEnabled:false});
    layer.onAdd(map as unknown as MapLibreMap,gl as unknown as WebGL2RenderingContext); await flushPreparation();
    // Production attaches this port for catalog mode. This contract fixture
    // intentionally has no catalog/GLB inventory, so attach the same boundary.
    (layer as any).initializeSurfaceClient();
    layer.updateRoadSurfaces([{id:'source-road',coordinates:[[61.393,55.165],[61.398,55.165]],className:'residential',lanes:2,drivable:true}],
      {bounds,buildings:{datasetVersion:'source',signature:'source',data:{type:'FeatureCollection',features:[]},canonicalIds:new Set(),
        cells:['cell'],coverage:'complete_viewport',coverageBounds:bounds,invalidBuildings:0,omittedBuildings:0,vertexCount:0}});
    expect(layer.roadSurfaceDiagnostics.retainedSegments).toBe(0); // Delivery is asynchronous.
    await flushPreparation();
    expect(layer.roadSurfaceDiagnostics.lastError).toBeNull();
    expect(layer.roadSurfaceDiagnostics).toMatchObject({state:'ready',retainedSegments:1});
    layer.render(gl as unknown as WebGL2RenderingContext,input());
    expect(harness.renderers[0].drawnNames.at(-1)).toContain('metric-road-asphalt');
    expect(layer.roadSurfaceDiagnostics.retainedSegments).toBe(1);
    expect(layer.ready).toBe(false);layer.dispose();
    expect(layer.roadSurfaceDiagnostics.retainedBytes).toBe(0);
  });
  it('keeps independent surface rendering available when city metadata is unavailable without fetching an unverified root',async()=>{
    const map=makeMap(),gl=makeGl();
    const layer=new TiledGameLayer({tilesetUrl:'https://example.org/unverified.json',qualityTier:'low',cityEnabled:false});
    layer.onAdd(map as unknown as MapLibreMap,gl as unknown as WebGL2RenderingContext); await flushPreparation();
    layer.updateWater([{id:'water',geometry:{type:'Polygon',coordinates:[[[61.39,55.16],[61.40,55.16],[61.40,55.17],[61.39,55.17],[61.39,55.16]]]}}]);
    layer.render(gl as unknown as WebGL2RenderingContext,input());
    expect(harness.tiles[0].update).not.toHaveBeenCalled();
    expect(layer.diagnostics.renderedFrames).toBeGreaterThan(0);
    expect(layer.ready).toBe(false);layer.dispose();
  });
  it('selects the nearest canonical native roof even before any GLB is ready and blocks unknown native occlusion', async () => {
    const map=makeMap(),gl=makeGl(),onPick=vi.fn();
    const layer=new TiledGameLayer({tilesetUrl:'https://example.org/tileset.json',qualityTier:'low',onPick});
    layer.onAdd(map as unknown as MapLibreMap,gl as unknown as WebGL2RenderingContext); await flushPreparation();
    layer.render(gl as unknown as WebGL2RenderingContext,input());
    const native=vi.fn(()=>({complete:true,hit:{id:'source:roof',point:new Vector3(0,10,0),distance:20}}));
    expect(layer.pickAt(300,200,native)?.id).toBe('source:roof');
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({kind:'building',id:'source:roof'}));
    expect(layer.pickAt(300,200,()=>({complete:false,hit:null}))).toBeNull();
    layer.dispose();
  });
  it('keeps the committed parent drawable while a child bank is preparing and restores an empty raw frontier', async () => {
    const map=makeMap(),gl=makeGl(),onFrontier=vi.fn();
    const layer=new TiledGameLayer({tilesetUrl:'https://example.org/tileset.json',qualityTier:'low',onFrontier});
    layer.onAdd(map as unknown as MapLibreMap,gl as unknown as WebGL2RenderingContext); await flushPreparation();
    const tiles=await loadCoarse(),parent=tiles.group.children[0];parent.children[0].name='committed-parent';
    layer.render(gl as unknown as WebGL2RenderingContext,input());
    layer.commitFrontier(layer.frontier);layer.setVisible(true);
    const child={parent:tiles.root,content:{uri:'child.glb'}},scene=new Group();
    const mesh=new Mesh(new BoxGeometry(1,4,1),new MeshBasicMaterial());mesh.name='candidate-child';scene.add(mesh);
    tiles.group.add(scene);tiles.emit('load-model',{tile:child,scene});await flushPreparation();
    tiles.update.mockImplementation(()=>{tiles.group.remove(parent);tiles.visibleTiles.clear();tiles.visibleTiles.add(child);});
    layer.render(gl as unknown as WebGL2RenderingContext,input());
    expect(harness.renderers[0].drawnNames.at(-1)).toContain('committed-parent');
    expect(harness.renderers[0].drawnNames.at(-1)).not.toContain('candidate-child');
    layer.commitFrontier(layer.frontier);
    layer.render(gl as unknown as WebGL2RenderingContext,input());
    expect(harness.renderers[0].drawnNames.at(-1)).toContain('candidate-child');
    expect(harness.renderers[0].drawnNames.at(-1)).not.toContain('committed-parent');
    tiles.update.mockImplementation(()=>{tiles.group.remove(scene);tiles.visibleTiles.clear();});
    layer.render(gl as unknown as WebGL2RenderingContext,input());
    expect(harness.renderers[0].drawnNames.at(-1)).toContain('candidate-child');
    expect(layer.frontier?.tileKeys).toEqual(['coarse.glb']);
    layer.dispose();
  });
  it('renders prepared actors when detailed buildings are hidden over native coverage', async () => {
    const map=makeMap(),gl=makeGl(),layer=new TiledGameLayer({tilesetUrl:'https://example.org/tileset.json',qualityTier:'low'});
    layer.onAdd(map as unknown as MapLibreMap,gl as unknown as WebGL2RenderingContext); await flushPreparation();
    await loadCoarse();
    const object=new Group(),body=new Mesh(new BoxGeometry(1,2,1),new MeshBasicMaterial());body.name='prepared-real-person';object.add(body);
    (layer as any).actors?.dispose();
    (layer as any).actors={object,setTime(){},updateCamera(){},dispose(){}};
    (layer as any).diagnosticsValue.actorsState='ready';
    (layer as any).scene.add(object);
    layer.setVisible(false);
    layer.render(gl as unknown as WebGL2RenderingContext,input());
    await flushPreparation();layer.render(gl as unknown as WebGL2RenderingContext,input());
    expect(harness.renderers[0].drawnNames.at(-1)).toContain('prepared-real-person');
    expect(layer.diagnostics.visible).toBe(false);
    expect(layer.diagnostics.actorsVisible).toBe(true);
    layer.dispose();
  });
  it('keeps committed child geometry drawable while an empty replacement frontier awaits its native bank',async()=>{
    const map=makeMap(),gl=makeGl(),onFrontier=vi.fn(),layer=new TiledGameLayer({tilesetUrl:'https://example.org/tileset.json',qualityTier:'low',onFrontier});
    layer.onAdd(map as unknown as MapLibreMap,gl as unknown as WebGL2RenderingContext); await flushPreparation();
    const tiles=await loadCoarse(),parent=tiles.group.children[0];layer.render(gl as unknown as WebGL2RenderingContext,input());layer.commitFrontier(layer.frontier);layer.setVisible(true);
    const child={parent:tiles.root,content:{uri:'retained-child.glb'}},scene=new Group(),body=new Mesh(new BoxGeometry(2,8,2),new MeshBasicMaterial());body.name='still-masked-canonical-child';body.userData.canonicalId='openmaptiles_buildings:123';scene.add(body);
    tiles.group.add(scene);tiles.emit('load-model',{tile:child,scene});await flushPreparation();tiles.visibleTiles.clear();tiles.visibleTiles.add(child);
    layer.render(gl as unknown as WebGL2RenderingContext,input());layer.commitFrontier(layer.frontier);
    let nativeExcluded=[...layer.displayedFrontier!.canonicalIds];
    // Normal post-commit retirement removes the coarse GLB, not the new child.
    tiles.group.remove(parent);tiles.emit('dispose-model',{tile:tiles.root});
    layer.render(gl as unknown as WebGL2RenderingContext,input());expect(layer.displayedFrontier?.tileKeys).toEqual(['retained-child.glb']);
    // A zoom/traversal change requests no detailed owners. The matching native
    // source worker is deliberately still pending, so its previous mask remains.
    tiles.update.mockImplementation(()=>{tiles.visibleTiles.clear();tiles.group.remove(scene);});
    harness.renderers[0].drawnNames.length=0;layer.render(gl as unknown as WebGL2RenderingContext,input());
    expect(layer.frontier?.tileKeys).toEqual([]);expect(layer.displayedFrontier?.tileKeys).toEqual(['retained-child.glb']);
    expect(nativeExcluded).toEqual(['openmaptiles_buildings:123']);
    expect(tiles.group.visible).toBe(true);expect(harness.renderers[0].drawnNames.at(-1)).toContain('still-masked-canonical-child');
    // Only the matching ready native bank releases this last mesh owner.
    nativeExcluded=[...layer.frontier!.canonicalIds];layer.commitFrontier(layer.frontier);
    layer.render(gl as unknown as WebGL2RenderingContext,input());expect(nativeExcluded).toEqual([]);expect(layer.ready).toBe(false);expect(tiles.group.visible).toBe(false);
    layer.dispose();
  });
  it('routes the real TilesRenderer root plugin and GLTF texture handler through the verified inventory', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn());
    try {
      const url = 'https://example.org/tileset.json';
      const initialTileset = { asset: { version: '1.1' }, root: { content: { uri: 'coarse.glb' } } } as CityVisualTileset;
      const layer = new TiledGameLayer({ tilesetUrl: url, qualityTier: 'medium', initialTileset,
        assetUrls: [url, 'https://example.org/coarse.glb', 'https://example.org/atlas.png'],
        assetIntegrity: ['https://example.org/coarse.glb', 'https://example.org/atlas.png']
          .map(url => ({url, bytes: 1, sha256: 'a'.repeat(64)})) });
      const map = makeMap(), gl = makeGl();
      layer.onAdd(map as unknown as MapLibreMap, gl as unknown as WebGL2RenderingContext); await flushPreparation();
      const tiles = harness.tiles[0];
      expect(tiles.registerPlugin).toHaveBeenCalledTimes(1);
      const plugin = tiles.registerPlugin.mock.calls[0][0];
      expect(await (await plugin.fetchData(url)).json()).toEqual(initialTileset);
      expect(tiles.lruCache.maxBytesSize).toBe(192 * 1024 * 1024);
      const modifier = tiles.manager.setURLModifier.mock.calls[0][0];
      expect(modifier('https://example.org/atlas.png')).toBe('https://example.org/atlas.png');
      const handler = tiles.manager.addHandler.mock.calls.find(([pattern]: [RegExp]) => pattern.test('atlas.png'))?.[1];
      expect(handler.isImageBitmapLoader).toBe(true);
      // A swallowed GLTF image error must not leave ready=true with missing material.
      expect(() => modifier('https://elsewhere.example/atlas.png')).toThrow(/inventory/i);
      expect(layer.diagnostics.state).toBe('error'); expect(layer.ready).toBe(false);
      layer.dispose();
    } finally { vi.unstubAllGlobals(); }
  });
  it('loads while hidden, switches only after coarse preparation, and never clears the main target', async () => {
    const map = makeMap(), gl = makeGl(), ready = vi.fn();
    const layer = new TiledGameLayer({ tilesetUrl: 'https://example.org/tileset.json', qualityTier: 'medium', onReady: ready });
    layer.onAdd(map as unknown as MapLibreMap, gl as unknown as WebGL2RenderingContext); await flushPreparation();
    const renderer = harness.renderers[0];
    expect(renderer.options.canvas).toBe(map.getCanvas());
    expect(renderer.options.context).toBe(gl);
    expect(renderer.options.logarithmicDepthBuffer).toBe(false);
    expect(renderer.options.reversedDepthBuffer).toBe(false);
    expect(renderer.autoClearDepth).toBe(false);
    const tiles = await loadCoarse();
    layer.render(gl as unknown as WebGL2RenderingContext, input());
    expect(tiles.update).toHaveBeenCalled();
    // Geometry preparation must not expose the first main pass to a null PCF map.
    expect(layer.diagnostics.preparedCoverage).toBe(true);
    expect(layer.ready).toBe(false); expect(ready).not.toHaveBeenCalled();
    expect(renderer.renders).toHaveLength(0);
    expect(layer.diagnostics.renderedFrames).toBe(0);
    // Bootstrap the cache while the native map still owns the visible city.
    layer.prerender(gl as unknown as WebGL2RenderingContext, input());
    expect(layer.ready).toBe(true); expect(ready).toHaveBeenCalledTimes(1);
    expect(renderer.renders).toHaveLength(1); expect(renderer.renders[0]).not.toBeNull();
    layer.setVisible(true);
    map.triggerRepaint.mockClear();
    layer.setTime({ presentationSeconds: 100, playing: true });
    layer.setTime({ presentationSeconds: 100.1, playing: true });
    expect(map.triggerRepaint).not.toHaveBeenCalled();
    layer.prerender(gl as unknown as WebGL2RenderingContext, input());
    expect(renderer.clears).toHaveLength(1);
    expect(renderer.clears[0]).not.toBeNull(); // Only our scratch target is cleared.
    const shadowCount = layer.diagnostics.shadowRenders;
    layer.render(gl as unknown as WebGL2RenderingContext, input());
    expect(renderer.renders.at(-1)).toBeNull();
    expect(renderer.clears).toHaveLength(1);
    expect(layer.diagnostics.renderedFrames).toBe(1);
    layer.prerender(gl as unknown as WebGL2RenderingContext, input());
    expect(layer.diagnostics.shadowRenders).toBe(shadowCount); // Paused stable cache.
    layer.dispose(); layer.dispose();
    expect(renderer.disposed).toBe(true); expect(tiles.dispose).toHaveBeenCalledTimes(1);
  });

  it('low tier renders geometry without allocating or rendering any shadow target', async () => {
    const map = makeMap(), gl = makeGl();
    const layer = new TiledGameLayer({ tilesetUrl: 'https://example.org/tileset.json', qualityTier: 'low' });
    layer.onAdd(map as unknown as MapLibreMap, gl as unknown as WebGL2RenderingContext); await flushPreparation();
    await loadCoarse(); layer.render(gl as unknown as WebGL2RenderingContext, input()); layer.setVisible(true);
    layer.prerender(gl as unknown as WebGL2RenderingContext, input());
    layer.render(gl as unknown as WebGL2RenderingContext, input());
    expect(harness.renderers[0].clears).toHaveLength(0);
    expect(harness.renderers[0].shadowMap.enabled).toBe(false);
    expect(layer.diagnostics.renderedFrames).toBe(1);
    layer.dispose();
  });

  it('rebuilds the PCF cache after context restoration before another main draw', async () => {
    const map = makeMap(), gl = makeGl(), ready = vi.fn();
    const layer = new TiledGameLayer({ tilesetUrl: 'https://example.org/tileset.json', qualityTier: 'medium', onReady: ready });
    layer.onAdd(map as unknown as MapLibreMap, gl as unknown as WebGL2RenderingContext); await flushPreparation();
    await loadCoarse(); layer.render(gl as unknown as WebGL2RenderingContext, input());
    layer.prerender(gl as unknown as WebGL2RenderingContext, input()); layer.setVisible(true);
    layer.render(gl as unknown as WebGL2RenderingContext, input());
    const frames = layer.diagnostics.renderedFrames;
    const lost = map.on.mock.calls.find(([type]) => type === 'webglcontextlost')![1];
    const restored = map.on.mock.calls.find(([type]) => type === 'webglcontextrestored')![1];
    lost(); expect(layer.ready).toBe(false);
    restored(); expect(layer.ready).toBe(false); expect(layer.diagnostics.shadowReady).toBe(false);
    await flushPreparation();
    layer.render(gl as unknown as WebGL2RenderingContext, input());
    expect(layer.diagnostics.renderedFrames).toBe(frames);
    layer.prerender(gl as unknown as WebGL2RenderingContext, input());
    expect(layer.ready).toBe(true); expect(ready).toHaveBeenCalledTimes(2);
    layer.render(gl as unknown as WebGL2RenderingContext, input());
    expect(layer.diagnostics.renderedFrames).toBe(frames + 1);
    layer.dispose();
    harness.tiles[0].emit('load-error', { tile: null, error: new Error('late aborted response') });
    expect(layer.diagnostics.state).toBe('disposed');
  });

  it('retains source-road aggregate rendering outside the quarter without drawing hidden city geometry', async () => {
    const map = makeMap(), gl = makeGl();
    const layer = new TiledGameLayer({ tilesetUrl: 'https://example.org/tileset.json', qualityTier: 'medium' });
    layer.onAdd(map as unknown as MapLibreMap, gl as unknown as WebGL2RenderingContext); await flushPreparation();
    const snapshot: AggregateRoadFlowSnapshot = { representation: 'schematic_road_flow', signature: 'unit-road-1', sourceLabel: 'unit-test source fixture',
      origin: [origin.longitude, origin.latitude], timeOriginSeconds: 0,
      segments: [{ id: 'unit-1', sourceRoadId: 'unit-source-road', start: [0, 0, 0.1], end: [100, 0, 0.1], phase: 0.4, speedMps: 8, lengthMeters: 100 }],
      diagnostics: { inputRoads: 1, invalidRoads: 0, excludedNonDrivableRoads: 0, scannedSegments: 1, invalidSegments: 0,
        skippedShortSegments: 0, outsideDistanceSegments: 0, withinDistanceSegments: 1, peakRetainedCandidates: 1 } };
    layer.setAggregateFlows(snapshot);
    layer.render(gl as unknown as WebGL2RenderingContext,input());await flushPreparation();
    layer.render(gl as unknown as WebGL2RenderingContext, input());
    expect(layer.ready).toBe(false);
    expect(layer.diagnostics.aggregateFlowSegments).toBe(1);
    expect(harness.renderers[0].drawnNames.at(-1)).toEqual(['game-schematic-road-flow']);
    await loadCoarse(); layer.render(gl as unknown as WebGL2RenderingContext, input());
    layer.prerender(gl as unknown as WebGL2RenderingContext, input());
    layer.setVisible(true); layer.render(gl as unknown as WebGL2RenderingContext, input());
    layer.setVisible(false); layer.render(gl as unknown as WebGL2RenderingContext, input());
    await flushPreparation();layer.render(gl as unknown as WebGL2RenderingContext,input());
    expect(harness.renderers[0].drawnNames.at(-1)).toEqual(['game-schematic-road-flow']);
    expect(layer.diagnostics.renderedVisibleTiles).toBe(0);
    layer.setAggregateFlows(null);
    const frames = layer.diagnostics.renderedFrames;
    layer.render(gl as unknown as WebGL2RenderingContext, input());
    expect(layer.diagnostics.renderedFrames).toBe(frames);
    layer.dispose();
  });
});
