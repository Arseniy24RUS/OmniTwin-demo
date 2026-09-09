import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Ray, Raycaster, Vector3 } from 'three';
import { createBoundedShadowReceiver, createGameAssetPolicy, gameQualityPolicy, gameSunForTime, pickVisibleCity, readGameTilesetMetadata, semanticBuildingId, TiledGameLayer } from '../renderer/game/TiledGameLayer';
import type { CityVisualTileset } from '../renderer/game/cityVisualPack';

describe('single-owner tiled game layer', () => {
  it('starts hidden and does not construct a canvas or render loop before MapLibre onAdd', () => {
    const layer = new TiledGameLayer({ tilesetUrl: 'https://example.org/tileset.json', qualityTier: 'low' });
    expect(layer.type).toBe('custom');
    expect(layer.renderingMode).toBe('3d');
    expect(layer.ready).toBe(false);
    expect(layer.diagnostics.renderedFrames).toBe(0);
    expect(layer.diagnostics.visible).toBe(false);
    layer.setTime({ presentationSeconds: 60, playing: false });
    layer.setVisible(true);
    layer.dispose();
    layer.dispose();
    expect(layer.diagnostics.state).toBe('disposed');
  });

  it('bounds tier budgets; low has no shadowmap and all tiers use one sun', () => {
    expect(gameQualityPolicy('low').shadowSize).toBe(0);
    expect(gameQualityPolicy('medium').shadowSize).toBe(1024);
    expect(gameQualityPolicy('high').shadowSize).toBe(2048);
    expect(gameQualityPolicy('medium').maxCacheBytes).toBe(192 * 1024 * 1024);
    expect(gameQualityPolicy('medium').maxCacheBytes + gameQualityPolicy('medium').auxiliaryReserveBytes).toBe(256 * 1024 * 1024);
    for (const tier of ['low', 'medium', 'high'] as const) {
      const policy = gameQualityPolicy(tier);
      expect(policy.maxCacheBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
      expect(policy.downloads).toBe(2);
      expect(policy.maxTiles).toBeLessThanOrEqual(192);
    }
  });

  it('reuses the verified root without network or mutation and restricts all content to exact URLs', async () => {
    const rootUrl = 'https://assets.example/packs/one/tileset.json';
    const glb = 'https://assets.example/packs/one/tiles/coarse.glb';
    const atlas = 'https://assets.example/packs/one/materials/atlas.png';
    const root = { asset: { version: '1.1' }, root: { content: { uri: 'tiles/coarse.glb' } } } as CityVisualTileset;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('content'));
    const assetIntegrity = [glb, atlas].map(url => ({url, bytes: 7, sha256: createHash('sha256').update('content').digest('hex')}));
    const policy = createGameAssetPolicy({ tilesetUrl: rootUrl, initialTileset: root, assetUrls: [rootUrl, glb, atlas], assetIntegrity }, fetcher)!;
    const first = await (await policy.fetchData(rootUrl)).json(); first.root.content.uri = 'changed';
    expect((await (await policy.fetchData(rootUrl)).json()).root.content.uri).toBe('tiles/coarse.glb');
    expect(root.root.content.uri).toBe('tiles/coarse.glb'); expect(fetcher).not.toHaveBeenCalled();
    expect(policy.resolve('https://assets.example/packs/one/tiles/../materials/atlas.png')).toBe(atlas);
    await policy.fetchData(glb, { credentials: 'include', redirect: 'follow' });
    expect(fetcher).toHaveBeenCalledWith(glb, expect.objectContaining({ credentials: 'omit', redirect: 'error', mode: 'cors', method: 'GET' }));
    for (const url of [glb + '?other=1', glb + '#fragment', 'https://evil.example/tiles.glb', 'https://assets.example/packs/two/tiles/coarse.glb', 'data:image/png;base64,AA==']) {
      await expect(policy.fetchData(url)).rejects.toThrow(/asset|URL/i);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    const aborted = new AbortController(); aborted.abort();
    await expect(policy.fetchData(rootUrl, { signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects partial verified-pack options before attaching a renderer', () => {
    const tilesetUrl = 'https://assets.example/tileset.json';
    expect(createGameAssetPolicy({ tilesetUrl })).toBeNull();
    expect(() => createGameAssetPolicy({ tilesetUrl, assetUrls: [tilesetUrl] })).toThrow(/together/i);
    expect(() => createGameAssetPolicy({ tilesetUrl, initialTileset: {} as CityVisualTileset })).toThrow(/together/i);
    expect(() => createGameAssetPolicy({ tilesetUrl, initialTileset: {} as CityVisualTileset, assetUrls: [] })).toThrow(/inventory/i);
  });

  it('requires bounded source coverage and declared EUS origin before native fallback can switch', () => {
    const tileset = { asset: { version: '1.1' }, root: { refine: 'REPLACE', transform: new Array(16).fill(0), content: { uri: 'coarse.glb' }, extras: {
      coordinateSystem: 'east-up-south', origin: [61.39466, 55.1654, 0], bounds: [61.38, 55.15, 61.41, 55.18],
    } } };
    expect(readGameTilesetMetadata(tileset).origin.longitude).toBe(61.39466);
    expect(() => readGameTilesetMetadata({ ...tileset, root: { ...tileset.root, extras: {} } })).toThrow(/origin|coordinate/i);
    expect(() => readGameTilesetMetadata({ ...tileset, root: { ...tileset.root, content: undefined } })).toThrow(/coarse/i);
  });

  it('ray-tests only visible cells intersecting the click and lets an opaque non-semantic wall occlude', () => {
    const front = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    front.position.z = 5;
    const rear = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    rear.userData.canonicalId = 'source:building:17';
    const group = new Group(); group.add(front, rear); group.updateMatrixWorld(true);
    const cells = [{ scene: group, bounds: new Box3().setFromObject(group) }];
    const camera = new PerspectiveCamera(); camera.position.set(0, 0, 10); camera.updateMatrixWorld();
    const hit = pickVisibleCity(new Ray(camera.position.clone(), new Vector3(0, 0, -1)), cells, camera);
    expect(hit?.distance).toBeCloseTo(4);
    expect(hit?.id).toBeNull();
    front.visible = false;
    expect(pickVisibleCity(new Ray(camera.position.clone(), new Vector3(0, 0, -1)), cells, camera)?.id).toBe('source:building:17');
    expect(pickVisibleCity(new Ray(new Vector3(100, 0, 10), new Vector3(0, 0, -1)), cells, camera)).toBeNull();
    front.geometry.dispose(); rear.geometry.dispose(); front.material.dispose(); rear.material.dispose();
  });

  it('resolves actual merged triangle ranges, not the whole tile or nearest building centre', () => {
    const mesh = new Mesh();
    mesh.userData.featureRanges = [
      { firstTriangle: 0, triangleCount: 12, canonicalId: 'source:building:a' },
      { firstTriangle: 12, triangleCount: 6, canonicalId: 'source:building:b' },
    ];
    expect(semanticBuildingId(mesh, 11)).toBe('source:building:a');
    expect(semanticBuildingId(mesh, 12)).toBe('source:building:b');
    expect(semanticBuildingId(mesh, 18)).toBeNull();
  });

  it('uses a two-triangle receive-only transparent lighting surface, not replacement ground', () => {
    const receiver = createBoundedShadowReceiver({ longitude: 61.39466, latitude: 55.1654 }, [61.39, 55.16, 61.40, 55.17]);
    expect(receiver.geometry.index!.count / 3).toBe(2);
    expect(receiver.material.isShadowMaterial).toBe(true);
    expect(receiver.material.transparent).toBe(true);
    expect(receiver.material.depthWrite).toBe(false);
    expect(receiver.receiveShadow).toBe(true); expect(receiver.castShadow).toBe(false);
    expect(receiver.position.y).toBe(0.015);
    expect(receiver.userData.lightingOnly).toBe(true);
    const raycaster = new Raycaster(receiver.position.clone().add(new Vector3(0, 20, 0)), new Vector3(0, -1, 0));
    receiver.updateMatrixWorld(true);
    expect(raycaster.intersectObject(receiver)).toHaveLength(0);
    receiver.geometry.dispose(); receiver.material.dispose();
  });

  it('updates the disclosed summer sun only at 15-minute presentation-time boundaries', () => {
    const origin = { longitude: 61.39466, latitude: 55.1654 };
    const morning = gameSunForTime(10 * 3600, origin);
    expect(gameSunForTime(10 * 3600 + 899, origin)).toEqual(morning);
    expect(gameSunForTime(10 * 3600 + 900, origin).bucket).toBe(morning.bucket + 1);
    expect(gameSunForTime(10 * 3600 + 86400, origin)).toEqual(morning);
    expect(morning.direction[0]).toBeGreaterThan(0); // Sun east of meridian.
    expect(gameSunForTime(18 * 3600, origin).direction[0]).toBeLessThan(0);
    expect(gameSunForTime(13 * 3600, origin).direction[1]).toBeGreaterThan(0.7);
    expect(gameSunForTime(0, origin).daylight).toBe(0);
  });
});
