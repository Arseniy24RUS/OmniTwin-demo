/** Local-only source-mode preview. Never rewrites canonical population, geography, spatial manifests or assignments. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat, open, unlink } from 'node:fs/promises';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { setPriority, constants } from 'node:os';
import { DATASET_ID, decodePersonShard, recordAt, decodeHouseholdShard, householdMembers } from '../shared/demo-population/index.mjs';
import { SPATIAL_NONE as NONE, decodeRoleShard, spatialCellKey } from '../shared/demo-population/spatial.mjs';
import { encodeMovementPage, decodeMovementCellContext } from '../shared/demo-population/movement-index.mjs';
import { createRouteCorridorBuilder } from '../shared/demo-population/route-corridors.mjs';
import { cellsForCorridor } from './build-city-movement-index-v2.mjs';
import { projectLocal, localBoundsToGeographic } from './visual/geometry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MiB = 1024 * 1024, SOURCE_ROAD_BASE = 1_000_000;
const LIMITS = Object.freeze({ sourceCells: 256, rolePages: 256, candidates: 150000, rawOutputBytes: 512 * MiB, assetBytes: 64 * MiB, contextBytes: 8 * MiB });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const isChild = (base, path) => { const child = relative(resolve(base), resolve(path)); return child && !child.startsWith('..') && !isAbsolute(child); };
const bytesEqual = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const jsonBytes = value => Buffer.from(JSON.stringify(value));

function normalizeOptions(input) {
  const root = resolve(input.root ?? ROOT), origin = input.origin ?? [61.39466, 55.1654];
  const options = { root, spatialManifest: join(root, 'apps/web/public/demo-v2/spatial/manifest.json'), populationManifest: join(root, 'apps/web/public/demo-v2/manifest.json'),
    geographyManifest: join(root, 'apps/web/public/city-v2/manifest.json'), output: join(root, '.cache/movement-mode-v2'), coreRadiusMeters: 600, guardRadiusMeters: 1500,
    pageSize: 2048, maxCandidates: LIMITS.candidates, maxOutputBytes: LIMITS.rawOutputBytes, ...input, origin };
  for (const key of ['spatialManifest', 'populationManifest', 'geographyManifest', 'output']) options[key] = resolve(options[key]);
  check(Array.isArray(origin) && origin.length === 2 && origin.every(Number.isFinite) && Math.abs(origin[0]) <= 180 && Math.abs(origin[1]) <= 85, 'Invalid overlay origin.');
  check(Number.isFinite(options.coreRadiusMeters) && options.coreRadiusMeters > 0 && options.coreRadiusMeters <= 600 && Number.isFinite(options.guardRadiusMeters)
    && options.guardRadiusMeters >= options.coreRadiusMeters && options.guardRadiusMeters <= 1500, 'Overlay core/guard exceeds authorized local bounds.');
  check(Number.isInteger(options.pageSize) && options.pageSize > 0 && options.pageSize <= 8192, 'Invalid overlay page size.');
  check(Number.isInteger(options.maxCandidates) && options.maxCandidates > 0 && options.maxCandidates <= LIMITS.candidates, 'Invalid overlay candidate limit.');
  check(Number.isSafeInteger(options.maxOutputBytes) && options.maxOutputBytes > 0 && options.maxOutputBytes <= LIMITS.rawOutputBytes, 'Invalid overlay raw output limit.');
  check(isChild(join(root, '.cache'), options.output), 'Overlay output must be a child of the workspace .cache directory.');
  check(![options.spatialManifest, options.populationManifest, options.geographyManifest].some(p => p === options.output || isChild(options.output, p)), 'Overlay output contains an immutable source manifest.');
  return options;
}
async function boundedRead(path, maximum) {
  const metadata = await stat(path); check(metadata.isFile() && metadata.size > 0 && metadata.size <= maximum, 'Overlay source file exceeds byte bound.');
  return readFile(path);
}
async function verified(base, descriptor, stats, maximum = LIMITS.assetBytes) {
  check(descriptor && /^[a-f0-9]{64}$/u.test(descriptor.sha256) && Number.isSafeInteger(descriptor.bytes) && descriptor.bytes > 0 && descriptor.bytes <= maximum, 'Invalid bounded overlay source descriptor.');
  check(typeof descriptor.url === 'string' && !isAbsolute(descriptor.url) && !descriptor.url.includes(':') && !descriptor.url.split(/[\\/]/u).includes('..'), 'Overlay source path escapes asset root.');
  const path = resolve(base, descriptor.url); check(isChild(base, path), 'Overlay source path escapes asset root.');
  const bytes = await boundedRead(path, maximum);
  check(bytes.length === descriptor.bytes && hash(bytes) === descriptor.sha256, `Overlay source hash/length mismatch: ${descriptor.url}`);
  stats.sourceReadBytes += bytes.length; return bytes;
}
function validateRanges(descriptors, total, firstKey, maximumCount) {
  check(Array.isArray(descriptors), 'Missing canonical source shard inventory.'); let next = 0;
  for (const d of descriptors) { check(d[firstKey] === next && Number.isInteger(d.count) && d.count > 0 && d.count <= maximumCount, 'Noncontiguous canonical shard inventory.'); next += d.count; }
  check(next === total, 'Incomplete canonical shard inventory.');
}
function bboxForKey(key) {
  const [, x, y] = key.split('/').map(Number), size = 65536;
  const lon = x => x / size * 360 - 180, lat = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}
function contextValue(key, origins, bindings, corridors) {
  const routeIds = new Set(), rows = origins.map(index => { const row = bindings.get(index); check(row, 'Missing overlay origin binding.'); for (const id of row.slice(1)) if (id !== null) routeIds.add(id); return row; });
  const value = { contract: 'DemoMovementCellContextV2', key, bindings: rows, roads: [...routeIds].sort((a, b) => a - b).map(id => corridors.get(id)) };
  const bytes = jsonBytes(value); check(bytes.length <= LIMITS.contextBytes, 'Overlay bindings/context exceeds 8 MiB; no truncation is permitted.'); decodeMovementCellContext(bytes); return bytes;
}

async function prepare(input = {}) {
  const options = normalizeOptions(input), progress = options.onProgress ?? (() => {});
  const stats = { coreBuildings: 0, coveredBuildings: 0, uniqueCandidates: 0, households: 0, householdMembers: 0, sourceCells: 0, sourceRoads: 0, rolePages: 0, sourceReadBytes: 0,
    expandedAssociations: 0, uniqueAssociations: 0, cells: 0, pages: 0, maxPageBytes: 0, maxContextBytes: 0, rawAssetBytes: 0, gzipAssetBytes: 0,
    unboundWalkOrigins: 0, unboundCarOrigins: 0, unboundOrigins: 0, unindexedCandidates: 0 };
  const manifestPaths = { spatial: options.spatialManifest, population: options.populationManifest, geography: options.geographyManifest };
  const manifestBytes = Object.fromEntries(await Promise.all(Object.entries(manifestPaths).map(async ([key, path]) => [key, await boundedRead(path, 8 * MiB)])));
  const baseHashes = Object.fromEntries(Object.entries(manifestBytes).map(([key, bytes]) => [key, hash(bytes)]));
  if (options.expectedBaseHashes) for (const key of Object.keys(baseHashes)) check(options.expectedBaseHashes[key] === baseHashes[key], `Overlay ${key} base pin changed.`);
  const spatial = JSON.parse(manifestBytes.spatial), population = JSON.parse(manifestBytes.population), geography = JSON.parse(manifestBytes.geography);
  check(spatial.contract === 'DemoSpatialManifestV2' && spatial.datasetId === DATASET_ID && spatial.representation === 'visual_synthesis' && Number.isSafeInteger(spatial.recordCount)
    && spatial.recordCount > 0 && spatial.recordCount <= 3_000_000 && Number.isSafeInteger(spatial.buildingCount) && spatial.buildingCount > 0 && spatial.buildingCount <= 150000, 'Invalid bounded spatial source.');
  check(population.contract === 'DemoPopulationManifestV2' && population.datasetId === DATASET_ID && population.recordCount === spatial.recordCount && population.householdCount === spatial.householdCount, 'Canonical population counts/contract mismatch.');
  check(geography.contract === 'DemoCityPackManifestV2' && geography.cellZoom === 16 && spatial.sourceHashes.populationManifest === baseHashes.population
    && spatial.sourceHashes.geographyManifest === baseHashes.geography && spatial.sourceHashes.buildingIndex === geography.buildingIndex.sha256, 'Canonical source manifest pin changed.');
  const codePaths = { populationCodec: 'shared/demo-population/index.mjs', spatialCodec: 'shared/demo-population/spatial.mjs', routeCorridorCodec: 'shared/demo-population/route-corridors.mjs',
    movementRoadPolicy: 'shared/demo-population/movement-road-policy.mjs', codec: 'shared/demo-population/movement-index.mjs', compiler: 'tools/build-city-movement-overlay-v2.mjs' };
  const codeHashes = Object.fromEntries(await Promise.all(Object.entries(codePaths).map(async ([key, path]) => [key, hash(await readFile(join(ROOT, path)))])));
  for (const key of ['populationCodec', 'spatialCodec']) check(codeHashes[key] === spatial.sourceHashes[key], 'Immutable population/spatial source codec changed.');
  const rows = JSON.parse(await verified(dirname(options.geographyManifest), geography.buildingIndex, stats, 32 * MiB)).rows;
  check(Array.isArray(rows) && rows.length === spatial.buildingCount, 'Canonical building ordinal count mismatch.');
  const core = new Set();
  rows.forEach((row, i) => { check(Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1]) && Number.isFinite(row[2]), 'Invalid source building index.');
    if (projectLocal([row[1], row[2]], options.origin).every(n => Math.abs(n) <= options.coreRadiusMeters)) core.add(i); });
  stats.coreBuildings = core.size; check(core.size > 0, 'Overlay core contains no source buildings.');
  const bounds = localBoundsToGeographic([-options.coreRadiusMeters, -options.coreRadiusMeters, options.coreRadiusMeters, options.coreRadiusMeters], options.origin);
  const sourceBounds = localBoundsToGeographic([-options.guardRadiusMeters, -options.guardRadiusMeters, options.guardRadiusMeters, options.guardRadiusMeters], options.origin);
  const sourceCells = geography.cells.filter(cell => intersects(cell.bbox, sourceBounds));
  check(sourceCells.length > 0 && sourceCells.length <= LIMITS.sourceCells, 'Overlay source cell limit exceeded.'); stats.sourceCells = sourceCells.length;
  const sourceRoads = new Map(), sourceRoadHashes = new Map();
  for (const descriptor of sourceCells) {
    const cell = JSON.parse(await verified(dirname(options.geographyManifest), descriptor, stats, 4 * MiB));
    check(cell.contract === 'DemoCityCellV2' && cell.key === descriptor.key && JSON.stringify(cell.bbox) === JSON.stringify(descriptor.bbox) && Array.isArray(cell.roads), 'Invalid verified source city cell.');
    for (const road of cell.roads) { const digest = hash(JSON.stringify(road)); check(!sourceRoadHashes.has(road.id) || sourceRoadHashes.get(road.id) === digest, 'Conflicting source road rows across cells.'); sourceRoadHashes.set(road.id, digest); sourceRoads.set(road.id, road); }
  }
  const roadList = [...sourceRoads.values()].sort((a, b) => compare(a.id, b.id)); stats.sourceRoads = roadList.length; check(roadList.length <= 150000, 'Overlay source road limit exceeded.');
  validateRanges(spatial.roleShards, spatial.buildingCount, 'firstIndex', 256);
  const selectedRolePages = spatial.roleShards.filter(d => [...core].some(i => i >= d.firstIndex && i < d.firstIndex + d.count));
  check(selectedRolePages.length <= LIMITS.rolePages, 'Overlay relevant role-page limit exceeded.'); stats.rolePages = selectedRolePages.length;
  const contexts = new Map(), originPeople = new Map();
  for (const descriptor of selectedRolePages) {
    const role = decodeRoleShard(await verified(dirname(options.spatialManifest), descriptor, stats));
    const details = await verified(dirname(options.spatialManifest), descriptor.contexts, stats), detailsView = view(details);
    check(role.startIndex === descriptor.firstIndex && role.count === descriptor.count && role.extra === spatial.recordCount && details.length === descriptor.members * 36
      && details.length / 36 === (role.bytes.length - role.memberStart) / 4, 'Role/context source alignment mismatch.');
    for (let local = 0; local < role.count; local++) {
      const building = role.startIndex + local; if (!core.has(building)) continue;
      for (let r = 0; r < 4; r++) {
        const row = local * 4 + r, start = role.view.getUint32(32 + row * 4, true), end = role.view.getUint32(36 + row * 4, true);
        for (let ordinal = start; ordinal < end; ordinal++) {
          const at = ordinal * 36, person = detailsView.getUint32(at, true), household = detailsView.getUint32(at + 4, true);
          check(person < spatial.recordCount && household < spatial.householdCount && person === role.view.getUint32(role.memberStart + ordinal * 4, true)
            && detailsView.getUint32(at + 20 + r * 4, true) === building, 'Canonical role/person/target mismatch.');
          const context = details.subarray(at, at + 36), existing = contexts.get(person);
          if (existing) check(bytesEqual(existing, context), 'Conflicting canonical person contexts.');
          else { check(contexts.size < options.maxCandidates, 'Overlay unique candidate limit exceeded; no truncation permitted.'); contexts.set(person, Uint8Array.from(context)); }
          if (!originPeople.has(building)) originPeople.set(building, new Set()); originPeople.get(building).add(person);
        }
      }
    }
  }
  const coveredBuildingIndices = [...originPeople.keys()].sort((a, b) => a - b); stats.coveredBuildings = coveredBuildingIndices.length; stats.uniqueCandidates = contexts.size;
  check(contexts.size > 0, 'No canonical people associated with local core origins.'); progress({ phase: 'canonical_core', ...stats });
  const householdIds = new Set([...contexts.values()].map(bytes => view(bytes).getUint32(4, true))), householdDefinitions = new Map(), memberOwners = new Map();
  validateRanges(population.householdShards, population.householdCount, 'startIndex', 4096);
  for (const descriptor of population.householdShards) {
    const ids = [...householdIds].filter(i => i >= descriptor.startIndex && i < descriptor.startIndex + descriptor.count); if (!ids.length) continue;
    const shard = decodeHouseholdShard(await verified(dirname(options.populationManifest), descriptor, stats));
    check(shard.startIndex === descriptor.startIndex && shard.count === descriptor.count, 'Canonical household shard range mismatch.');
    for (const id of ids) {
      const household = householdMembers(shard, id); check(household.members.length > 0 && household.members.length <= 100, 'Invalid complete household.'); householdDefinitions.set(id, household);
      for (const person of household.members) { check(person < population.recordCount && !memberOwners.has(person), 'Duplicate/invalid canonical household member.'); memberOwners.set(person, id); }
    }
  }
  check(householdDefinitions.size === householdIds.size, 'Missing complete canonical households.');
  const memberRecords = new Map(); validateRanges(population.personShards, population.recordCount, 'startIndex', 8192);
  const sortedMembers = [...memberOwners.keys()].sort((a, b) => a - b); let memberCursor = 0;
  for (const descriptor of population.personShards) {
    const start = memberCursor; while (memberCursor < sortedMembers.length && sortedMembers[memberCursor] < descriptor.startIndex + descriptor.count) memberCursor++;
    if (memberCursor === start) continue;
    const shard = decodePersonShard(await verified(dirname(options.populationManifest), descriptor, stats));
    check(shard.startIndex === descriptor.startIndex && shard.count === descriptor.count, 'Canonical person shard range mismatch.');
    for (const person of sortedMembers.slice(start, memberCursor)) {
      const record = recordAt(shard, person), raw = shard.bytes.subarray(32 + (person - shard.startIndex) * 16, 48 + (person - shard.startIndex) * 16);
      check(record.householdIndex === memberOwners.get(person), 'Canonical household/person membership mismatch.');
      const context = contexts.get(person);
      if (context) { check(bytesEqual(raw, context.subarray(4, 20)), 'Canonical person bytes changed in source context.');
        const home = view(context).getUint32(20, true); check((home === NONE ? null : home) === householdDefinitions.get(record.householdIndex).homeBuildingIndex, 'Canonical household home assignment changed.'); }
      memberRecords.set(person, Buffer.from(raw).toString('base64'));
    }
  }
  for (const person of contexts.keys()) check(memberOwners.has(person) && memberRecords.has(person), 'Core candidate absent from complete canonical household.');
  const households = new Map([...householdDefinitions].map(([id, h]) => [id, { householdIndex: id, members: [...h.members].sort((a, b) => a - b).map(person => [person, memberRecords.get(person)]) }]));
  stats.households = households.size; stats.householdMembers = memberRecords.size;
  const builder = createRouteCorridorBuilder(roadList, { targetMeters: 1000, maxMeters: 1500, maxSegments: 12, maxCachedRoutes: 2048 });
  check(typeof builder.selectSeed === 'function' && typeof builder.buildBest === 'function', 'Source-mode corridor helper is not ready.');
  const roadOrdinals = new Map(roadList.map((road, index) => [road.id, SOURCE_ROAD_BASE + index])), corridors = new Map(), bindings = new Map(), corridorCells = new Map();
  for (const building of coveredBuildingIndices) {
    const row = [building, null, null];
    for (const [mode, offset] of [['walk', 0], ['car', 1]]) {
      const seed = builder.selectSeed([rows[building][1], rows[building][2]], { mode, maxDistanceMeters: 750 });
      if (seed) {
        const sourceRoadIndex = roadOrdinals.get(seed.sourceRoadId), index = sourceRoadIndex * 2 + offset;
        if (!corridors.has(index)) {
          const route = builder.buildBest(seed.sourceRoadId, { mode });
          if (route) {
            const road = { ...route, id: `source-mode-v2:${mode}:${seed.sourceRoadId}:${hash(route.id).slice(0, 16)}`, index, sourceRoadIndex, mode };
            corridors.set(index, road); corridorCells.set(index, cellsForCorridor(road));
          }
        }
        if (corridors.has(index)) row[offset + 1] = index;
      }
      if (row[offset + 1] === null) stats[offset ? 'unboundCarOrigins' : 'unboundWalkOrigins']++;
    }
    if (row[1] === null && row[2] === null) stats.unboundOrigins++; bindings.set(building, row);
  }
  const globalBindings = contextValue(spatialCellKey(...options.origin), coveredBuildingIndices, bindings, corridors);
  const cellMap = new Map(), indexedPeople = new Set();
  for (const [building, members] of originPeople) {
    const keys = new Set(bindings.get(building).slice(1).flatMap(index => [...(corridorCells.get(index) ?? [])]));
    for (const key of keys) {
      let cell = cellMap.get(key); if (!cell) { cell = { key, origins: new Set(), people: new Set() }; cellMap.set(key, cell); }
      cell.origins.add(building); stats.expandedAssociations += members.size;
      for (const person of members) { cell.people.add(person); indexedPeople.add(person); }
    }
  }
  stats.unindexedCandidates = contexts.size - indexedPeople.size;
  const cells = [...cellMap.values()].sort((a, b) => compare(a.key, b.key)).map(cell => ({ key: cell.key, bbox: bboxForKey(cell.key),
    origins: [...cell.origins].sort((a, b) => a - b), people: [...cell.people].sort((a, b) => a - b) }));
  check(cells.length <= 256, 'Overlay output cell limit exceeded.'); stats.cells = cells.length; stats.uniqueAssociations = cells.reduce((n, c) => n + c.people.length, 0);
  progress({ phase: 'source_corridors', ...stats });
  return { options, stats, baseHashes, manifestPaths, codePaths, codeHashes, spatial, population, rows, bounds, sourceBounds, coveredBuildingIndices,
    contexts, households, bindings, corridors, globalBindings, cells, sourceCells: sourceCells.map(c => ({ key: c.key, sha256: c.sha256, bytes: c.bytes })) };
}

function* pagesFor(state, cell, people = cell.people, sequence = { next: 0 }) {
  if (people.length > state.options.pageSize) { for (let start = 0; start < people.length; start += state.options.pageSize) yield* pagesFor(state, cell, people.slice(start, start + state.options.pageSize), sequence); return; }
  const contexts = new Uint8Array(people.length * 36), householdIds = new Set(), buildingIds = new Set();
  people.forEach((person, i) => { const raw = state.contexts.get(person); check(raw, 'Missing canonical overlay context.'); contexts.set(raw, i * 36); const v = view(raw); householdIds.add(v.getUint32(4, true));
    for (let role = 0; role < 4; role++) { const building = v.getUint32(20 + role * 4, true); if (building !== NONE) { check(building < state.rows.length, 'Canonical target missing source metadata.'); buildingIds.add(building); } } });
  const summary = index => { const row = state.rows[index]; return { index, id: row[0], center: [row[1], row[2]], districtId: row[3], use: row[4] }; };
  let bytes;
  try { bytes = encodeMovementPage({ key: cell.key, contexts, households: [...householdIds].sort((a, b) => a - b).map(h => state.households.get(h)), buildings: [...buildingIds].sort((a, b) => a - b).map(summary) }); }
  catch (error) { if (error.code !== 'MOVEMENT_PAGE_TOO_LARGE' || people.length < 2) throw error; const split = Math.ceil(people.length / 2); yield* pagesFor(state, cell, people.slice(0, split), sequence); yield* pagesFor(state, cell, people.slice(split), sequence); return; }
  yield { sequence: sequence.next++, bytes, count: people.length, firstPersonIndex: people[0], lastPersonIndex: people.at(-1) };
}
async function verifyPins(state) {
  for (const [key, path] of Object.entries(state.manifestPaths)) check(hash(await boundedRead(path, 8 * MiB)) === state.baseHashes[key], `Overlay ${key} source changed during run.`);
  for (const [key, path] of Object.entries(state.codePaths)) check(hash(await readFile(join(ROOT, path))) === state.codeHashes[key], `Overlay ${key} code changed during run.`);
}
function estimate(state) {
  let raw = state.globalBindings.length, pages = 0, maximumPage = 0, maximumContext = state.globalBindings.length;
  for (const cell of state.cells) {
    const context = contextValue(cell.key, cell.origins, state.bindings, state.corridors); raw += context.length; maximumContext = Math.max(maximumContext, context.length);
    for (const page of pagesFor(state, cell)) { raw += page.bytes.length; pages++; maximumPage = Math.max(maximumPage, page.bytes.length);
      check(raw + 512 * 1024 <= state.options.maxOutputBytes, 'Overlay raw output byte limit exceeded in preflight; no truncation permitted.'); }
  }
  check(raw + 512 * 1024 <= state.options.maxOutputBytes, 'Overlay raw output byte limit exceeded in preflight.');
  return { estimatedRawOutputBytes: raw + 512 * 1024, exactPayloadBytes: raw, manifestReserveBytes: 512 * 1024, pages, maxPageBytes: maximumPage, maxContextBytes: maximumContext };
}
function planFor(state, estimate) {
  return { contract: 'DemoMovementOverlayPreflightV2', withinLimits: true, dryRun: true, baseHashes: state.baseHashes, overlayCodecSha256: state.codeHashes.movementRoadPolicy,
    origin: state.options.origin, bounds: state.bounds, sourceBounds: state.sourceBounds, output: state.options.output, coveredBuildingIndices: state.coveredBuildingIndices,
    stats: { ...state.stats, pages: estimate.pages, maxPageBytes: estimate.maxPageBytes, maxContextBytes: estimate.maxContextBytes }, limits: LIMITS, ...estimate };
}
export async function preflightMovementOverlay(options = {}) {
  const state = await prepare(options), measured = estimate(state); await verifyPins(state); return planFor(state, measured);
}
async function writeAsset(output, stem, value, tally, maximum) {
  const bytes = value instanceof Uint8Array ? Buffer.from(value) : jsonBytes(value), digest = hash(bytes), url = `${stem}-${digest.slice(0, 16)}.json`;
  check(tally.raw + bytes.length <= maximum, 'Overlay raw output byte limit exceeded; no partial manifest published.');
  const path = join(output, url), compressed = gzipSync(bytes, { level: 6 }); await mkdir(dirname(path), { recursive: true });
  for (const [destination, data] of [[path, bytes], [`${path}.gz`, compressed]]) {
    let existing = null; try { existing = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) check(bytesEqual(existing, data), 'Hash-named overlay asset unexpectedly changed.');
    else { await writeFile(`${destination}.next`, data); await rename(`${destination}.next`, destination); }
  }
  tally.raw += bytes.length; tally.gzip += compressed.length;
  return { url, sha256: digest, bytes: bytes.length, gzip: { url: `${url}.gz`, sha256: hash(compressed), bytes: compressed.length } };
}
export async function compileMovementOverlay(options = {}) {
  const state = await prepare(options), measured = estimate(state); await verifyPins(state);
  const output = state.options.output; await mkdir(output, { recursive: true });
  const lockPath = join(output, '.build.lock'), lock = await open(lockPath, 'wx');
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, baseHashes: state.baseHashes }));
    const tally = { raw: 0, gzip: 0 }, asset = (stem, bytes) => writeAsset(output, stem, bytes, tally, state.options.maxOutputBytes);
    const bindings = await asset('bindings', state.globalBindings), cells = [];
    let pages = 0;
    for (const cell of state.cells) {
      const context = await asset(`cells/${cell.key}/context`, contextValue(cell.key, cell.origins, state.bindings, state.corridors)), descriptors = [];
      for (const page of pagesFor(state, cell)) {
        const descriptor = await asset(`cells/${cell.key}/pages/${String(page.sequence).padStart(4, '0')}`, page.bytes);
        descriptors.push({ ...descriptor, count: page.count, firstPersonIndex: page.firstPersonIndex, lastPersonIndex: page.lastPersonIndex }); pages++;
      }
      cells.push({ key: cell.key, bbox: cell.bbox, context, count: cell.people.length, pages: descriptors });
      state.options.onProgress?.({ phase: 'write_cell', completed: cells.length, total: state.cells.length, rawAssetBytes: tally.raw });
    }
    const stats = { ...state.stats, pages, maxPageBytes: measured.maxPageBytes, maxContextBytes: measured.maxContextBytes, rawAssetBytes: tally.raw, gzipAssetBytes: tally.gzip };
    const manifest = { contract: 'DemoMovementOverlayV2', version: 'source-mode-v2', datasetId: DATASET_ID, representation: 'visual_synthesis', scientificClaim: false,
      scope: 'local_preview', chatCompatibility: 'pending', baseHashes: state.baseHashes, overlayCodecSha256: state.codeHashes.movementRoadPolicy,
      bounds: state.bounds, sourceBounds: state.sourceBounds, origin: state.options.origin, coveredBuildingIndices: state.coveredBuildingIndices,
      indexNamespace: { kind: 'local_overlay', sourceRoadIndexBase: SOURCE_ROAD_BASE, ordering: 'lexicographic_verified_source_road_id', notGlobalGeographyOrdinals: true },
      bindings, cells, cellZoom: 16, pageSize: state.options.pageSize, maxPageSize: 8192, maxPageBytes: LIMITS.contextBytes,
      recordCount: state.spatial.recordCount, householdCount: state.spatial.householdCount, buildingCount: state.spatial.buildingCount,
      sourceHashes: { populationManifest: state.baseHashes.population, geographyManifest: state.baseHashes.geography, baseSpatialManifest: state.baseHashes.spatial,
        buildingIndex: state.spatial.sourceHashes.buildingIndex, ...state.codeHashes }, sourceCells: state.sourceCells, stats,
      semantics: { coverage: 'Every canonical person in any core-origin role roster is indexed in every cell touched by either new bound corridor of all their core origins; persons are deduplicated per cell.',
        scope: 'Only coveredBuildingIndices receive replacement bindings. This is not whole-city movement coverage or a ready scientific population model.',
        indexing: 'Canonical people, households and all four target assignments are copied from verified immutable bytes without changed IDs or fabricated memberships. Corridor ordinals use an isolated local overlay namespace.',
        modeIntegrity: 'Strict source-mode policy; missing eligible walk/car routes remain explicit null. No inferred paired sidewalk or carriageway fallback. Unindexed/unbound counts are reported.',
        householdCompleteness: 'Every page includes complete canonical household membership/person records for every candidate household, plus all candidate target-building metadata.',
        activity: 'Candidates are not visible actors. Consumers re-evaluate canonical presence, current origin, mode and corridor position before visibility or output caps.',
        sourceBounds: 'Guard rectangle selects verified source cells; full source ways are retained unmodified and may extend outside the guard. Source bounds do not assert complete network coverage beyond the guard.' } };
    const manifestBytes = jsonBytes(manifest); check(tally.raw + manifestBytes.length * 2 <= state.options.maxOutputBytes, 'Overlay manifest exceeds final raw output limit.');
    await verifyPins(state); const manifestDescriptor = await asset('manifest', manifestBytes);
    await writeFile(join(output, 'manifest.json.next'), manifestBytes); await rename(join(output, 'manifest.json.next'), join(output, 'manifest.json'));
    return { manifest, manifestPath: join(output, manifestDescriptor.url), manifestDescriptor, stats, published: false, preflight: planFor(state, measured) };
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {}, expectedBaseHashes = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--build', '--dry-run'].includes(arg)) continue;
    if (['--root', '--output', '--spatial-manifest', '--population-manifest', '--geography-manifest'].includes(arg)) {
      const keys = { '--root': 'root', '--output': 'output', '--spatial-manifest': 'spatialManifest', '--population-manifest': 'populationManifest', '--geography-manifest': 'geographyManifest' };
      check(args[i + 1], `Missing ${arg} value.`); options[keys[arg]] = args[++i]; continue;
    }
    if (arg.startsWith('--expect-') && ['spatial', 'population', 'geography'].includes(arg.slice(9))) { check(/^[a-f0-9]{64}$/u.test(args[i + 1] ?? ''), 'Invalid expected base SHA-256.'); expectedBaseHashes[arg.slice(9)] = args[++i]; continue; }
    throw new Error(`Unsupported local overlay argument: ${arg}`);
  }
  if (Object.keys(expectedBaseHashes).length) { check(Object.keys(expectedBaseHashes).length === 3, 'All three expected base hashes are required.'); options.expectedBaseHashes = expectedBaseHashes; }
  const build = args.includes('--build'); check(!(build && args.includes('--dry-run')), 'Choose --build or --dry-run, not both.');
  if (build) { setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL); options.onProgress = status => process.stderr.write(`${JSON.stringify(status)}\n`); }
  (build ? compileMovementOverlay(options).then(result => ({ manifestPath: result.manifestPath, manifestDescriptor: result.manifestDescriptor, baseHashes: result.manifest.baseHashes, stats: result.stats, published: false })) : preflightMovementOverlay(options))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
