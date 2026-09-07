/** Bounded OpenFreeMap vector-tile capture. Never downloads a country/planet archive. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import assert from 'node:assert/strict';

// Load the SAME pure TS identity/geometry helpers used by the browser, rather than
// maintaining a second canonical-ID implementation. Node 22.18+ supports TS stripping.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
  }
  return next(specifier, context);
} });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { buildCityRoadGraph } = await import(pathToFileURL(join(root, 'apps/web/src/demo/cityRoadGraph.ts')).href);
const { cityLayoutFromFeatures } = await import(pathToFileURL(join(root, 'apps/web/src/demo/cityLayout.ts')).href);
const out = join(root, 'apps/web/public/city');
const center = [61.4026, 55.1644];
const z = 14;
const maxBytes = 20 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const xAt = (lon, zoom) => Math.floor((lon + 180) / 360 * 2 ** zoom);
const yAt = (lat, zoom) => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** zoom);
const lonAt = (x, zoom) => x / 2 ** zoom * 360 - 180;
const latAt = (y, zoom) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** zoom))) * 180 / Math.PI;
await mkdir(out, { recursive: true });
let oldManifest = null;
try { oldManifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')); } catch {}
const networkRead = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000), headers: { 'User-Agent': 'OmniTwin-demo bounded city tile pack builder (https://github.com/Arseniy24RUS/OmniTwin-demo)' } });
  if (!response.ok) throw new Error(`Source request failed: ${response.status} ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 2 * 1024 * 1024) throw new Error(`Single tile exceeds 2 MiB bound: ${url}`);
  return data;
};
const sourceUrl = 'https://tiles.openfreemap.org/planet';
let source;
if (oldManifest && !process.argv.includes('--refresh')) {
  const sourceBytes = await readFile(join(out, oldManifest.sourceSnapshot.url));
  assert.equal(sourceBytes.length, oldManifest.sourceSnapshot.bytes, 'Pinned source metadata length mismatch');
  assert.equal(sha(sourceBytes), oldManifest.sourceSnapshot.sha256, 'Pinned source metadata hash mismatch');
  source = JSON.parse(sourceBytes);
} else source = JSON.parse(await networkRead(sourceUrl));
assert.equal(source.maxzoom, 14, 'Inspect source schema after an upstream maxzoom change');
assert.ok(source.tiles.length === 1 && source.tiles[0].startsWith('https://tiles.openfreemap.org/planet/'));
const datasetVersion = source.tiles[0].split('/planet/')[1].split('/')[0];
const packId = `chelyabinsk-center-${datasetVersion}`;
const directory = join(out, packId);
await mkdir(directory, { recursive: true });
const sourceText = JSON.stringify(source);
const sourceSnapshot = { url: `${packId}/source-tilejson.json`, sha256: sha(sourceText), bytes: Buffer.byteLength(sourceText) };
await writeFile(join(out, sourceSnapshot.url), sourceText);
const cx = xAt(center[0], z); const cy = yAt(center[1], z);
const range = { minX: cx - 2, maxX: cx + 2, minY: cy - 2, maxY: cy + 2 };
const bounds = [lonAt(range.minX, z), latAt(range.maxY + 1, z), lonAt(range.maxX + 1, z), latAt(range.minY, z)];
const coordinates = [];
for (let zoom = 10; zoom <= 14; zoom++) {
  const divisor = 2 ** (14 - zoom);
  for (let x = Math.floor(range.minX / divisor); x <= Math.floor(range.maxX / divisor); x++) {
    for (let y = Math.floor(range.minY / divisor); y <= Math.floor(range.maxY / divisor); y++) coordinates.push({ z: zoom, x, y });
  }
}
assert.ok(coordinates.length <= 49, 'Bounded center pack must not expand beyond 49 tiles');
const tiles = [];
const features = { buildings: [], transportation: [] };
let bytes = 0;
for (const coord of coordinates) {
  const relative = `${packId}/tiles/${coord.z}/${coord.x}/${coord.y}.pbf`;
  const path = join(out, relative);
  const prior = oldManifest?.tiles?.find(tile => tile.url === relative);
  let data = null;
  if (prior && existsSync(path)) {
    const cached = await readFile(path);
    if (cached.length === prior.bytes && sha(cached) === prior.sha256) data = cached;
  }
  // Intentionally serial: no request/decoding burst while the scientific run is active.
  if (!data) {
    const url = source.tiles[0].replace('{z}', coord.z).replace('{x}', coord.x).replace('{y}', coord.y);
    data = await networkRead(url);
    if (bytes + data.length > maxBytes) throw new Error('20 MiB city pack budget exceeded');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  bytes += data.length;
  assert.ok(bytes <= maxBytes);
  const tile = new VectorTile(new PbfReader(data));
  tiles.push({ ...coord, url: relative, sha256: sha(data), bytes: data.length });
  if (coord.z === 14) {
    for (const [layerName, destination] of [['building', 'buildings'], ['transportation', 'transportation']]) {
      const layer = tile.layers[layerName];
      for (let i = 0; i < (layer?.length ?? 0); i++) {
        const f = layer.feature(i).toGeoJSON(coord.x, coord.y, coord.z);
        if (destination === 'buildings') {
          // Tiny source structures are still drawn in the basemap, but not used as homes.
          if (Number(f.properties.render_height ?? 5) < 2.5 || f.properties.hide_3d === true) continue;
          features.buildings.push({ ...f, source: 'openmaptiles', sourceLayer: 'building', layer: { id: 'building-3d' } });
        } else if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
          features.transportation.push({ ...f, sourceLayer: 'transportation' });
        }
      }
    }
  }
  console.log(`${tiles.length}/${coordinates.length} z${coord.z}/${coord.x}/${coord.y} ${data.length} bytes${prior ? ' cached' : ''}`);
}
assert.ok(features.buildings.length > 100 && features.transportation.length > 100, 'Actual city coverage is unexpectedly empty');
const roads = buildCityRoadGraph({ features: features.transportation, origin: center, presentationTimeSeconds: 1767225600, maxDistanceMeters: 2500, maxPeople: 0, maxCars: 0 });
const descriptor = { id: 'openmaptiles_buildings', role: 'buildings', datasetVersion };
const layout = cityLayoutFromFeatures({ ...features, buildingSource: descriptor, camera: { longitude: center[0], latitude: center[1], zoom: 16, pitch: 45, bearing: 0 } }, roads.roads);
// Stable fixture scope: all assignments use real buildings around the initial tour.
layout.buildings = layout.buildings.filter(b => Math.hypot((b.center[0] - center[0]) * 111320 * Math.cos(center[1] * Math.PI / 180), (b.center[1] - center[1]) * 111320) <= 2500).sort((a, b) => a.id.localeCompare(b.id));
layout.roads.sort((a, b) => a.id.localeCompare(b.id));
assert.ok(layout.buildings.length > 50 && layout.roads.some(r => r.walkable) && layout.roads.some(r => r.drivable));
const layoutText = JSON.stringify(layout);
const layoutAsset = { url: `${packId}/layout-${sha(layoutText).slice(0, 16)}.json`, sha256: sha(layoutText), bytes: Buffer.byteLength(layoutText), buildings: layout.buildings.length, roads: layout.roads.length };
await writeFile(join(out, layoutAsset.url), layoutText);
const tilejson = { ...source, name: 'OmniTwin bounded Chelyabinsk center pack', minzoom: 10, maxzoom: 14, bounds, center: [...center, 14], tiles: [`./tiles/{z}/{x}/{y}.pbf`] };
const tilejsonText = JSON.stringify(tilejson);
const tilejsonAsset = { url: `${packId}/tilejson.json`, sha256: sha(tilejsonText), bytes: Buffer.byteLength(tilejsonText) };
await writeFile(join(out, tilejsonAsset.url), tilejsonText);
const manifest = {
  contract: 'DemoCityPackManifestV1', packId, provider: 'OpenFreeMap / OpenMapTiles', datasetVersion,
  sourceTileJSON: sourceUrl, sourceTiles: source.tiles[0], sourceSnapshot,
  sourceSchema: 'OpenMapTiles 3.16', attribution: source.attribution,
  licenses: [{ name: 'OpenStreetMap ODbL 1.0', url: 'https://www.openstreetmap.org/copyright' }, { name: 'OpenMapTiles attribution', url: 'https://openmaptiles.org/' }, { name: 'OpenFreeMap source/self-hosting', url: 'https://openfreemap.org/' }],
  coverage: 'bounded_chelyabinsk_center_not_whole_city', bounds, center, minzoom: 10, maxzoom: 14,
  note: 'Untouched source vector tiles; source-backed layout is display-only. Outside these tile coordinates, use the declared streaming source. No full-city or offline-global completeness claim.',
  compilerSourceHashes: Object.fromEntries(await Promise.all([
    'tools/build-city-pack.mjs', 'apps/web/src/demo/cityRoadGraph.ts',
    'apps/web/src/demo/cityLayout.ts', 'apps/web/src/renderer/buildingSource.ts',
  ].map(async name => [name, sha(await readFile(join(root, name)))]))),
  tileCount: tiles.length, tileBytes: bytes, tilejson: tilejsonAsset, layout: layoutAsset, tiles,
};
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ packId, tileCount: tiles.length, tileBytes: bytes, bounds, layout: layoutAsset }, null, 2));
