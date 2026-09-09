/** Additive, offline route-cell coverage. Canonical population/presence stay unchanged. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { setPriority, constants } from 'node:os';
import { DATASET_ID } from '../shared/demo-population/index.mjs';
import { SPATIAL_NONE as NONE, decodeRoleShard, spatialCellKey } from '../shared/demo-population/spatial.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const ZOOM = 16; const SIZE = 2 ** ZOOM;
const tileLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / SIZE))) * 180 / Math.PI;
const tileLon = (x) => x / SIZE * 360 - 180;
const xy = (lon, lat) => spatialCellKey(lon, lat).split('/').slice(1).map(Number);
const keyOf = (x, y) => `${ZOOM}/${x}/${y}`;
export const DEFAULT_MOVEMENT_PAGE_SIZE = 2048;

/** Exact grid traversal for dailyMovement's linear source-coordinate segments. */
export function cellsForCorridor(road) {
  check(Array.isArray(road?.coordinates) && road.coordinates.length >= 2 && road.coordinates.length <= 4096, 'Invalid bounded corridor.');
  const cells = new Set();
  for (let i = 1; i < road.coordinates.length; i++) {
    const a = road.coordinates[i - 1]; const b = road.coordinates[i]; let [x, y] = xy(a[0], a[1]); const [endX, endY] = xy(b[0], b[1]);
    const dx = b[0] - a[0]; const dy = b[1] - a[1]; cells.add(keyOf(x, y)); let steps = 0;
    while (x !== endX || y !== endY) {
      check(++steps <= 128, 'Unbounded route-cell segment.');
      const tx = x === endX || dx === 0 ? Infinity : (tileLon(x + (dx > 0 ? 1 : 0)) - a[0]) / dx;
      const ty = y === endY || dy === 0 ? Infinity : (tileLat(y + (dy > 0 ? 0 : 1)) - a[1]) / dy;
      if (tx <= ty + 1e-12) x += dx > 0 ? 1 : -1;
      if (ty <= tx + 1e-12) y += dy > 0 ? -1 : 1;
      cells.add(keyOf(x, y));
    }
  }
  check(cells.size <= 128, 'Unbounded corridor cell footprint.'); return cells;
}

async function verified(base, descriptor, maximum = 64 * 1024 * 1024) {
  check(descriptor && /^[a-f0-9]{64}$/.test(descriptor.sha256) && Number.isSafeInteger(descriptor.bytes) && descriptor.bytes >= 0 && descriptor.bytes <= maximum, 'Invalid movement input descriptor.');
  check(typeof descriptor.url === 'string' && !isAbsolute(descriptor.url) && !descriptor.url.split(/[\\/]/).includes('..'), 'Movement input escapes source directory.');
  const path = resolve(base, descriptor.url); const child = relative(resolve(base), path); check(child && !child.startsWith('..') && !isAbsolute(child), 'Movement input escapes source directory.');
  const bytes = await readFile(path); check(bytes.length === descriptor.bytes && sha(bytes) === descriptor.sha256, 'Movement source hash mismatch.'); return bytes;
}
async function asset(output, stem, value) {
  const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value)); const digest = sha(bytes); const url = `${stem}-${digest.slice(0, 16)}.json`; const path = join(output, url);
  await mkdir(dirname(path), { recursive: true }); await writeFile(`${path}.next`, bytes); await rename(`${path}.next`, path);
  const compressed = gzipSync(bytes, { level: 6 }); await writeFile(`${path}.gz.next`, compressed); await rename(`${path}.gz.next`, `${path}.gz`);
  return { url, sha256: digest, bytes: bytes.length, gzip: { url: `${url}.gz`, sha256: sha(compressed), bytes: compressed.length } };
}

export async function compileMovementIndex({ root = ROOT, spatialManifest = join(root, 'apps/web/public/demo-v2/spatial/manifest.json'), populationManifest = join(root, 'apps/web/public/demo-v2/manifest.json'), geographyManifest = join(root, 'apps/web/public/city-v2/manifest.json'), output = join(dirname(spatialManifest), 'movement'), pageSize = DEFAULT_MOVEMENT_PAGE_SIZE, publish = true } = {}) {
  const started = performance.now(); const { encodeMovementPage, decodeMovementCellContext } = await import('../shared/demo-population/movement-index.mjs');
  check(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 8192, 'Invalid movement page size.');
  const sourceBytes = await readFile(spatialManifest); const spatial = JSON.parse(sourceBytes); const sourceDirectory = dirname(spatialManifest);
  check(spatial.contract === 'DemoSpatialManifestV2' && spatial.datasetId === DATASET_ID && spatial.representation === 'visual_synthesis' && spatial.recordCount > 0 && spatial.recordCount <= 3_000_000 && spatial.buildingCount > 0 && spatial.buildingCount <= 150_000, 'Invalid bounded spatial source.');
  const personCount = spatial.recordCount; const householdCount = spatial.householdCount; const buildingCount = spatial.buildingCount;
  check(Number.isSafeInteger(householdCount) && householdCount > 0 && householdCount <= personCount, 'Invalid household count.');
  const populationBytes = await readFile(populationManifest); check(sha(populationBytes) === spatial.sourceHashes.populationManifest, 'Population source changed.');
  const geoBytes = await readFile(geographyManifest); check(sha(geoBytes) === spatial.sourceHashes.geographyManifest, 'Geography source changed.'); const geo = JSON.parse(geoBytes);
  check(geo.buildingIndex.sha256 === spatial.sourceHashes.buildingIndex, 'Building ordinal source changed.');
  const index = JSON.parse(await verified(dirname(geographyManifest), geo.buildingIndex, 32 * 1024 * 1024)); check(index.rows.length === buildingCount, 'Building count mismatch.'); const buildingRows = index.rows;
  for (const [field, path] of [['populationCodec', 'shared/demo-population/index.mjs'], ['spatialCodec', 'shared/demo-population/spatial.mjs'], ['routeCorridorCodec', 'shared/demo-population/route-corridors.mjs']]) check(sha(await readFile(join(root, path))) === spatial.sourceHashes[field], 'Canonical source codec changed.');

  const bindings = new Uint32Array(buildingCount * 2).fill(NONE); const roads = new Map(); const roadHashes = new Map(); const roadCells = new Map();
  let next = 0;
  for (const descriptor of spatial.bindingShards) {
    check(descriptor.firstIndex === next && descriptor.count > 0 && descriptor.count <= 256, 'Noncontiguous route binding pages.'); next += descriptor.count;
    const page = JSON.parse(await verified(sourceDirectory, descriptor, 8 * 1024 * 1024));
    check(page.contract === 'DemoHomeRoadBindingsV2' && page.firstIndex === descriptor.firstIndex && page.count === descriptor.count, 'Invalid route binding source.');
    for (const road of page.roads) {
      const digest = sha(JSON.stringify(road)); check(!roadHashes.has(road.index) || roadHashes.get(road.index) === digest, 'Conflicting canonical corridor definitions.');
      if (!roads.has(road.index)) { roads.set(road.index, road); roadHashes.set(road.index, digest); roadCells.set(road.index, cellsForCorridor(road)); }
    }
    for (const [building, walk, car] of page.bindings) {
      check(building >= descriptor.firstIndex && building < next, 'Binding outside source page.');
      for (const [mode, route] of [[0, walk], [1, car]]) { check(route === null || roads.has(route), 'Missing canonical corridor.'); if (route !== null) check(mode ? roads.get(route).drivable : roads.get(route).walkable, 'Ineligible canonical route mode.'); bindings[building * 2 + mode] = route ?? NONE; }
    }
  }
  check(next === buildingCount, 'Incomplete route bindings.'); roadHashes.clear();

  const canonical = new Uint8Array(personCount * 36); const canonicalView = new DataView(canonical.buffer); let seen = new Uint8Array(personCount); let seenCount = 0;
  let householdCounts = new Uint32Array(householdCount); const buildingCounts = new Uint32Array(buildingCount);
  next = 0;
  for (const descriptor of spatial.roleShards) {
    check(descriptor.firstIndex === next && descriptor.count > 0 && descriptor.count <= 256, 'Noncontiguous role pages.'); next += descriptor.count;
    const role = decodeRoleShard(await verified(sourceDirectory, descriptor)); const contexts = await verified(sourceDirectory, descriptor.contexts);
    check(role.startIndex === descriptor.firstIndex && role.count === descriptor.count && contexts.length === descriptor.members * 36 && contexts.length / 36 === (role.bytes.length - role.memberStart) / 4, 'Role context alignment mismatch.');
    for (let local = 0; local < role.count; local++) buildingCounts[role.startIndex + local] = role.view.getUint32(32 + (local + 1) * 16, true) - role.view.getUint32(32 + local * 16, true);
    const view = new DataView(contexts.buffer, contexts.byteOffset, contexts.byteLength);
    for (let ordinal = 0; ordinal < descriptor.members; ordinal++) {
      const at = ordinal * 36; const person = view.getUint32(at, true); const h = view.getUint32(at + 4, true);
      check(person < personCount && h < householdCount && person === role.view.getUint32(role.memberStart + ordinal * 4, true), 'Invalid canonical movement member.');
      if (!seen[person]) { canonical.set(contexts.subarray(at, at + 36), person * 36); seen[person] = 1; seenCount++; householdCounts[h]++; }
      else for (let byte = 0; byte < 36; byte++) check(canonical[person * 36 + byte] === contexts[at + byte], 'Conflicting canonical person contexts.');
    }
  }
  check(next === buildingCount && seenCount === personCount, 'Role contexts do not cover the entire population; explicit unplaced handling is required.'); seen = null;
  const householdOffsets = new Uint32Array(householdCount + 1);
  for (let h = 0; h < householdCount; h++) { check(householdCounts[h] > 0 && householdCounts[h] <= 100, 'Invalid complete household.'); householdOffsets[h + 1] = householdOffsets[h] + householdCounts[h]; }
  const householdMembers = new Uint32Array(personCount); let householdCursors = householdOffsets.slice(0, -1);
  for (let person = 0; person < personCount; person++) householdMembers[householdCursors[canonicalView.getUint32(person * 36 + 4, true)]++] = person;
  householdCounts = null; householdCursors = null;

  const cellMap = new Map(); const buildingCellKeys = new Array(buildingCount);
  for (let building = 0; building < buildingCount; building++) if (buildingCounts[building]) {
    const keys = new Set(); for (let mode = 0; mode < 2; mode++) for (const key of roadCells.get(bindings[building * 2 + mode]) ?? []) keys.add(key);
    check(keys.size > 0, 'Assigned building has no route-cell binding.'); buildingCellKeys[building] = [...keys].sort();
    for (const key of keys) { let cell = cellMap.get(key); if (!cell) { cell = { key, count: 0, buildings: [] }; cellMap.set(key, cell); } cell.count += buildingCounts[building]; cell.buildings.push(building); }
  }
  const cells = [...cellMap.values()].sort((a, b) => a.key.localeCompare(b.key)); check(cells.length > 0 && cells.length <= 10_000, 'Unbounded movement cell count.');
  const cellIds = new Map(cells.map((cell, i) => [cell.key, i])); const cellOffsets = new Uint32Array(cells.length + 1);
  for (let i = 0; i < cells.length; i++) { check(cells[i].count <= 1_000_000, 'Unbounded cell associations.'); cellOffsets[i + 1] = cellOffsets[i] + cells[i].count; }
  const expandedAssociations = cellOffsets.at(-1); check(expandedAssociations <= 20_000_000, 'Movement association budget exceeded.');
  const members = new Uint32Array(expandedAssociations); const cursors = cellOffsets.slice(0, -1); const buildingCellIds = buildingCellKeys.map((keys) => keys?.map((key) => cellIds.get(key)));
  for (const descriptor of spatial.roleShards) {
    const role = decodeRoleShard(await verified(sourceDirectory, descriptor));
    for (let local = 0; local < role.count; local++) for (let r = 0; r < 4; r++) {
      const building = role.startIndex + local; const row = local * 4 + r; const start = role.view.getUint32(32 + row * 4, true); const end = role.view.getUint32(36 + row * 4, true);
      for (let ordinal = start; ordinal < end; ordinal++) { const person = role.view.getUint32(role.memberStart + ordinal * 4, true); check(canonicalView.getUint32(person * 36 + 20 + r * 4, true) === building, 'Role association disagrees with canonical target.'); for (const cell of buildingCellIds[building]) members[cursors[cell]++] = person; }
    }
  }
  for (let i = 0; i < cells.length; i++) check(cursors[i] === cellOffsets[i + 1], 'Movement CSR fill mismatch.');
  const summary = (i) => { const b = buildingRows[i]; return { index: i, id: b[0], center: [b[1], b[2]], districtId: b[3], use: b[4] }; };
  const outputCells = []; let uniqueAssociations = 0; let maxPageBytes = 0; let maxContextBytes = 0; let pageCount = 0; let rawBytes = 0; let gzipBytes = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]; const positions = cell.key.split('/').slice(1).map(Number); const bbox = [tileLon(positions[0]), tileLat(positions[1] + 1), tileLon(positions[0] + 1), tileLat(positions[1])];
    const routeIds = new Set(); const rows = cell.buildings.map((building) => { const pair = [bindings[building * 2], bindings[building * 2 + 1]]; for (const route of pair) if (route !== NONE) routeIds.add(route); return [building, ...pair.map((route) => route === NONE ? null : route)]; });
    const contextBytes = Buffer.from(JSON.stringify({ contract: 'DemoMovementCellContextV2', key: cell.key, bindings: rows, roads: [...routeIds].sort((a, b) => a - b).map((route) => roads.get(route)) }));
    check(contextBytes.length <= 8 * 1024 * 1024, 'Cell context exceeds runtime byte budget.'); decodeMovementCellContext(contextBytes);
    const context = await asset(output, `cells/${cell.key}/context`, contextBytes); maxContextBytes = Math.max(maxContextBytes, context.bytes); rawBytes += context.bytes; gzipBytes += context.gzip.bytes;
    const sorted = members.subarray(cellOffsets[i], cellOffsets[i + 1]); sorted.sort(); const pages = []; let pageSequence = 0;
    const emit = async (people) => {
      const contexts = new Uint8Array(people.length * 36); const householdIds = new Set(); const buildingIds = new Set();
      for (let p = 0; p < people.length; p++) { const person = people[p]; contexts.set(canonical.subarray(person * 36, person * 36 + 36), p * 36); householdIds.add(canonicalView.getUint32(person * 36 + 4, true)); for (let role = 0; role < 4; role++) { const building = canonicalView.getUint32(person * 36 + 20 + role * 4, true); if (building !== NONE) buildingIds.add(building); } }
      const households = [...householdIds].sort((a, b) => a - b).map((h) => ({ householdIndex: h, members: Array.from(householdMembers.subarray(householdOffsets[h], householdOffsets[h + 1]), (p) => [p, Buffer.from(canonical.subarray(p * 36 + 4, p * 36 + 20)).toString('base64')]) }));
      let encoded;
      try { encoded = encodeMovementPage({ key: cell.key, contexts, households, buildings: [...buildingIds].sort((a, b) => a - b).map(summary) }); }
      catch (error) { if (error.code !== 'MOVEMENT_PAGE_TOO_LARGE' || people.length < 2) throw error; const split = Math.ceil(people.length / 2); await emit(people.slice(0, split)); await emit(people.slice(split)); return; }
      const descriptor = await asset(output, `cells/${cell.key}/pages/${String(pageSequence++).padStart(4, '0')}`, encoded);
      pages.push({ ...descriptor, count: people.length, firstPersonIndex: people[0], lastPersonIndex: people.at(-1) }); pageCount++; maxPageBytes = Math.max(maxPageBytes, descriptor.bytes); rawBytes += descriptor.bytes; gzipBytes += descriptor.gzip.bytes;
    };
    let batch = []; let previous = -1; let count = 0;
    for (const person of sorted) { if (person === previous) continue; previous = person; batch.push(person); count++; if (batch.length === pageSize) { await emit(batch); batch = []; } }
    if (batch.length) await emit(batch); uniqueAssociations += count; outputCells.push({ key: cell.key, bbox, context, count, pages });
  }
  const baseSpatial = { ...spatial }; delete baseSpatial.movementIndex;
  const sourceHashes = { populationManifest: spatial.sourceHashes.populationManifest, geographyManifest: spatial.sourceHashes.geographyManifest, buildingIndex: spatial.sourceHashes.buildingIndex, populationCodec: spatial.sourceHashes.populationCodec, spatialCodec: spatial.sourceHashes.spatialCodec, routeCorridorCodec: spatial.sourceHashes.routeCorridorCodec, baseSpatialManifest: sha(`${JSON.stringify(baseSpatial)}\n`), codec: sha(await readFile(join(root, 'shared/demo-population/movement-index.mjs'))), compiler: sha(await readFile(fileURLToPath(import.meta.url))) };
  const manifest = { contract: 'DemoMovementIndexManifestV2', datasetId: DATASET_ID, representation: 'visual_synthesis', scientificClaim: false, recordCount: personCount, householdCount, buildingCount, cellZoom: 16, pageSize, maxPageSize: 8192, maxPageBytes: 8 * 1024 * 1024, sourceHashes, cells: outputCells, stats: { expandedAssociations, uniqueAssociations, cells: cells.length, pages: pageCount, maxPageBytes, maxContextBytes, rawAssetBytes: rawBytes, gzipAssetBytes: gzipBytes }, semantics: { coverage: 'Every lifetime canonical person indexed in every cell crossed by either bound source corridor of any potential origin building; deduplicated within cell, never fabricated copies.', activity: 'Consumers evaluate existing shared presenceFor with full household records, select current-origin canonical bindings, evaluate dailyMovement and actual viewport position before any output cap. Inactive/future/indoor members remain candidates, not visible actors.', modeIntegrity: 'Cell contexts retain both canonical modes for each included building even if only one corridor touches this cell; missing modes must never manufacture a fallback.', partial: 'Pages contain complete sorted memberships. A runtime budget may stop progressively only with explicit partial status; no capped candidate count is presented as complete coverage.' } };
  const movementAsset = await asset(output, 'manifest', manifest); const outputPrefix = relative(sourceDirectory, output).replaceAll('\\', '/'); check(outputPrefix && !outputPrefix.startsWith('..') && !isAbsolute(outputPrefix), 'Movement output must remain inside spatial directory.');
  let spatialManifestSha256 = sha(sourceBytes);
  if (publish) {
    check(sha(await readFile(spatialManifest)) === sha(sourceBytes), 'Spatial manifest changed during build; publication was not applied.');
    const pointer = { ...movementAsset, url: `${outputPrefix}/${movementAsset.url}`, gzip: { ...movementAsset.gzip, url: `${outputPrefix}/${movementAsset.gzip.url}` } };
    const finalBytes = Buffer.from(`${JSON.stringify({ ...spatial, movementIndex: pointer })}\n`); await writeFile(`${spatialManifest}.next`, finalBytes); await rename(`${spatialManifest}.next`, spatialManifest); spatialManifestSha256 = sha(finalBytes);
  }
  return { spatialManifestSha256, movementManifest: movementAsset, sourceHashes, stats: manifest.stats, seconds: Math.round((performance.now() - started) / 1000), maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), published: publish };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL);
  compileMovementIndex().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`Movement index compilation failed: ${error.message}\n`); process.exitCode = 1; });
}
