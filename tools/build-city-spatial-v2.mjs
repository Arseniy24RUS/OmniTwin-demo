/** Offline deterministic visual-synthesis assignments; never observed occupancy. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { DATASET_ID, DISTRICT_IDS, SCENARIO_IDS, PERSON_SHARD_SIZE, HEADER_BYTES, decodePersonShard, recordAt, decodeHouseholdShard, householdMembers, hashIndex } from '../shared/demo-population/index.mjs';
import { SPATIAL_NONE as NONE, BUILDING_ROLE_SHARD_SIZE, MAX_CELL_CANDIDATES, encodeTargetShard, encodeRoleShard, buildDestinationPools, selectDestination, potentialRoles, spatialCellKey, visitorEligible, householdHasVehicle, householdTripFor, decodeEmbeddedPerson } from '../shared/demo-population/spatial.mjs';
import { createRouteCorridorBuilder } from '../shared/demo-population/route-corridors.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const nullIndex = (n) => n === NONE ? null : n;
const MAX_PEOPLE = 3_000_000;
const MAX_BUILDINGS = 150_000;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

async function verified(base, descriptor, maximum = MAX_ASSET_BYTES) {
  check(descriptor && /^[a-f0-9]{64}$/.test(descriptor.sha256) && Number.isSafeInteger(descriptor.bytes) && descriptor.bytes > 0 && descriptor.bytes <= maximum, 'Invalid bounded spatial input descriptor.');
  check(typeof descriptor.url === 'string' && !isAbsolute(descriptor.url) && !descriptor.url.split(/[\\/]/).includes('..'), 'Input path escapes source directory.');
  const file = resolve(base, descriptor.url); const child = relative(resolve(base), file);
  check(child && !child.startsWith('..') && !isAbsolute(child), 'Input path escapes source directory.');
  const bytes = await readFile(file); check(bytes.length === descriptor.bytes && sha(bytes) === descriptor.sha256, 'Spatial source hash mismatch.'); return bytes;
}
async function asset(output, stem, value, binary = false) {
  const bytes = binary ? Buffer.from(value) : Buffer.from(JSON.stringify(value)); const digest = sha(bytes);
  const url = `${stem}-${digest.slice(0, 16)}.${binary ? 'bin' : 'json'}`; const file = join(output, url);
  await mkdir(dirname(file), { recursive: true }); await writeFile(`${file}.next`, bytes); await rename(`${file}.next`, file);
  const compressed = gzipSync(bytes, { level: 6 }); await writeFile(`${file}.gz.next`, compressed); await rename(`${file}.gz.next`, `${file}.gz`);
  return { url, sha256: digest, bytes: bytes.length, gzip: { url: `${url}.gz`, sha256: sha(compressed), bytes: compressed.length } };
}
function contiguous(shards, total, maximum) {
  check(Array.isArray(shards) && shards.length > 0, 'Missing source shards.'); let next = 0;
  for (const shard of shards) { check(shard.startIndex === next && Number.isInteger(shard.count) && shard.count > 0 && shard.count <= maximum, 'Noncontiguous source shards.'); next += shard.count; }
  check(next === total, 'Source shard count mismatch.');
}

/** Stable exact-polyline nearest bindings; no inferred road-to-road connectors. */
export function nearestRoadBindings(buildings, roads, needed, maxDistanceMeters = 750) {
  const scaleX = 111_320 * Math.cos(55.1644 * Math.PI / 180); const scaleY = 110_540; const size = 500;
  const point = (p) => [(p[0] - 61.4026) * scaleX, (p[1] - 55.1644) * scaleY];
  const grid = new Map();
  roads.forEach((road, index) => {
    check(typeof road.id === 'string' && Array.isArray(road.coordinates) && road.coordinates.length >= 2, 'Invalid source road.');
    const cells = new Set();
    for (let i = 1; i < road.coordinates.length; i++) {
      const a = point(road.coordinates[i - 1]); const b = point(road.coordinates[i]);
      check([...a, ...b].every(Number.isFinite), 'Invalid source road coordinates.');
      const minX = Math.floor(Math.min(a[0], b[0]) / size); const maxX = Math.floor(Math.max(a[0], b[0]) / size);
      const minY = Math.floor(Math.min(a[1], b[1]) / size); const maxY = Math.floor(Math.max(a[1], b[1]) / size);
      check((maxX - minX + 1) * (maxY - minY + 1) <= 4096, 'Unbounded source road segment.');
      for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) cells.add(`${x}:${y}`);
    }
    for (const key of cells) { let bucket = grid.get(key); if (!bucket) { bucket = []; grid.set(key, bucket); } bucket.push(index); }
  });
  const bindings = new Uint32Array(buildings.length * 2); bindings.fill(NONE); const distances = new Float32Array(buildings.length * 2);
  for (let building = 0; building < buildings.length; building++) {
    if (!needed[building]) continue; const p = point([buildings[building][1], buildings[building][2]]); const cx = Math.floor(p[0] / size); const cy = Math.floor(p[1] / size);
    const candidates = new Set(); const radius = Math.ceil(maxDistanceMeters / size);
    for (let x = cx - radius; x <= cx + radius; x++) for (let y = cy - radius; y <= cy + radius; y++) for (const index of grid.get(`${x}:${y}`) ?? []) candidates.add(index);
    const best = [maxDistanceMeters, maxDistanceMeters];
    for (const index of candidates) {
      const road = roads[index]; if (!road.walkable && !road.drivable) continue; let distance = Infinity;
      for (let i = 1; i < road.coordinates.length; i++) {
        const a = point(road.coordinates[i - 1]); const b = point(road.coordinates[i]); const dx = b[0] - a[0]; const dy = b[1] - a[1];
        const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
        distance = Math.min(distance, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
      }
      for (let mode = 0; mode < 2; mode++) if ((mode ? road.drivable : road.walkable) && (distance < best[mode] || distance === best[mode] && (bindings[building * 2 + mode] === NONE || road.id < roads[bindings[building * 2 + mode]].id))) {
        best[mode] = distance; bindings[building * 2 + mode] = index; distances[building * 2 + mode] = distance;
      }
    }
  }
  return { bindings, distances };
}

export async function compileSpatial({ root = ROOT, populationManifest = join(root, 'apps/web/public/demo-v2/manifest.json'), geographyManifest = join(root, 'apps/web/public/city-v2/manifest.json'), output = join(root, 'apps/web/public/demo-v2/spatial'), includeRoadBindings = true } = {}) {
  const populationBytes = await readFile(populationManifest); const population = JSON.parse(populationBytes);
  const geoBytes = await readFile(geographyManifest); const geo = JSON.parse(geoBytes);
  check(population.contract === 'DemoPopulationManifestV2' && population.datasetId === DATASET_ID && population.representation === 'fictional_demo' && population.scientificClaim === false && population.recordCount > 0 && population.recordCount <= MAX_PEOPLE && population.householdCount > 0 && population.householdCount <= MAX_PEOPLE, 'Invalid bounded fictional population manifest.');
  check(geo.contract === 'DemoCityPackManifestV2' && geo.buildingIndex.count > 0 && geo.buildingIndex.count <= MAX_BUILDINGS, 'Invalid geography manifest.');
  const geoBase = dirname(geographyManifest); const popBase = dirname(populationManifest);
  let indexBytes = await verified(geoBase, geo.buildingIndex, 32 * 1024 * 1024); const buildingIndex = JSON.parse(indexBytes); indexBytes = null;
  check(buildingIndex.columns.join(',') === 'id,lon,lat,districtId,use,areaM2,levels,heightM,capacityWeight,classificationProvenance,aliases' && buildingIndex.rows.length === geo.buildingIndex.count, 'Building index schema mismatch.');
  check(population.spatial.buildingIndex.sha256 === geo.buildingIndex.sha256, 'Population home building ordinals do not match geography.');
  const buildings = buildingIndex.rows; const buildingCount = buildings.length; const personCount = population.recordCount; const householdCount = population.householdCount;
  contiguous(population.personShards, personCount, PERSON_SHARD_SIZE); contiguous(population.householdShards, householdCount, 4096);
  let homes = new Uint32Array(householdCount); homes.fill(NONE); let districts = new Uint8Array(householdCount); districts.fill(255);
  const householdOffsets = new Uint32Array(householdCount + 1); const householdMemberIndices = new Uint32Array(personCount); let memberCursor = 0;
  for (const descriptor of population.householdShards) {
    const shard = decodeHouseholdShard(await verified(popBase, descriptor, 4 * 1024 * 1024)); check(shard.startIndex === descriptor.startIndex && shard.count === descriptor.count, 'Household shard header mismatch.');
    for (let index = shard.startIndex; index < shard.startIndex + shard.count; index++) {
      const row = householdMembers(shard, index); check(row.homeBuildingIndex === null || row.homeBuildingIndex < buildingCount, 'Invalid home building.');
      homes[index] = row.homeBuildingIndex ?? NONE; districts[index] = row.districtIndex ?? 255; householdOffsets[index] = memberCursor;
      for (const person of row.members) { check(person < personCount && memberCursor < personCount, 'Invalid household member.'); householdMemberIndices[memberCursor++] = person; }
    }
  }
  householdOffsets[householdCount] = memberCursor; check(memberCursor === personCount, 'Household member totals mismatch.');
  const rawPeople = new Uint8Array(personCount * 16); const personHomes = new Uint32Array(personCount); personHomes.fill(NONE);
  const targets = new Uint32Array(personCount * 3); targets.fill(NONE); let roleCounts = new Uint32Array(buildingCount * 4); const needed = new Uint8Array(buildingCount);
  const pools = buildDestinationPools(buildings); const visitorPools = new Map(); const targetShards = [];
  check(Array.isArray(geo.buildingPages) && geo.buildingPages.length > 0, 'Pinned source building metadata is required for visitor eligibility.');
  let nextBuilding = 0; let eligibleVisitorBuildings = 0;
  for (const descriptor of geo.buildingPages) {
    check(descriptor.firstIndex === nextBuilding && descriptor.count > 0 && descriptor.count <= 512, 'Noncontiguous building metadata.');
    const page = JSON.parse(await verified(geoBase, descriptor, 4 * 1024 * 1024));
    check(page.contract === 'DemoBuildingPageV2' && page.firstIndex === nextBuilding && page.buildings.length === descriptor.count, 'Invalid source building metadata page.');
    for (const building of page.buildings) {
      const row = buildings[nextBuilding]; check(building.index === nextBuilding && row && building.id === row[0] && building.use === row[4], 'Source building metadata ordinal mismatch.');
      if (visitorEligible(building) && DISTRICT_IDS.includes(row[3])) {
        const key = `${row[3]}:visitor`; let pool = visitorPools.get(key);
        if (!pool) { pool = { buildings: [], cumulative: [], total: 0 }; visitorPools.set(key, pool); }
        const weight = row[5] * (Number.isFinite(row[6]) && row[6] > 0 ? row[6] : 1);
        check(Number.isFinite(weight) && weight > 0, 'Invalid visitor building floor-area weight.');
        pool.total += weight; pool.buildings.push(nextBuilding); pool.cumulative.push(pool.total); eligibleVisitorBuildings++;
      }
      nextBuilding++;
    }
  }
  check(nextBuilding === buildingCount, 'Incomplete source building metadata.');
  const stats = { home: 0, work: 0, study: 0, visitor: 0, eligibleVisitorBuildings, unplacedHome: 0, unplacedWork: 0, unplacedStudy: 0, unplacedVisitor: 0 };
  const cells = new Map();
  const offer = (building, person) => {
    if (building === NONE) return; const b = buildings[building]; const key = spatialCellKey(b[1], b[2]); let bucket = cells.get(key);
    if (!bucket) { bucket = { entries: [], seen: new Set(), worst: 0 }; cells.set(key, bucket); }
    if (bucket.seen.has(person)) return; const priority = hashIndex(person, 9182026); const entries = bucket.entries;
    if (entries.length < MAX_CELL_CANDIDATES) { entries.push({ person, priority }); bucket.seen.add(person); if (entries.at(-1).priority > entries[bucket.worst].priority) bucket.worst = entries.length - 1; }
    else if (priority < entries[bucket.worst].priority || priority === entries[bucket.worst].priority && person < entries[bucket.worst].person) {
      bucket.seen.delete(entries[bucket.worst].person); entries[bucket.worst] = { person, priority }; bucket.seen.add(person);
      for (let i = 0; i < entries.length; i++) if (entries[i].priority > entries[bucket.worst].priority || entries[i].priority === entries[bucket.worst].priority && entries[i].person > entries[bucket.worst].person) bucket.worst = i;
    }
  };
  for (const descriptor of population.personShards) {
    const shard = decodePersonShard(await verified(popBase, descriptor, 256 * 1024)); check(shard.startIndex === descriptor.startIndex && shard.count === descriptor.count, 'Person shard header mismatch.');
    rawPeople.set(shard.bytes.subarray(HEADER_BYTES), shard.startIndex * 16);
    for (let index = shard.startIndex; index < shard.startIndex + shard.count; index++) {
      const record = recordAt(shard, index); const h = record.householdIndex; check(h < householdCount, 'Person household reference outside population.');
      const home = homes[h]; personHomes[index] = home; const district = districts[h] === 255 ? null : DISTRICT_IDS[districts[h]]; const potential = potentialRoles(record);
      if (home !== NONE) { roleCounts[home * 4]++; stats.home++; needed[home] = 1; offer(home, index); } else stats.unplacedHome++;
      for (const [role, offset] of [['work', 0], ['study', 1]]) if (potential[role]) {
        const destination = home === NONE ? null : selectDestination(pools, district, role, index, role === 'work' ? 9052026 : 9062026);
        if (destination === null) stats[role === 'work' ? 'unplacedWork' : 'unplacedStudy']++;
        else { targets[index * 3 + offset] = destination; roleCounts[destination * 4 + offset + 1]++; stats[role]++; needed[destination] = 1; offer(destination, index); }
      }
      if (record.birthYear <= 2018) {
        // Every lifetime adult has at most one potential visitor destination.
        // It is not capped by the number of GPU actors or an observed capacity.
        const visitor = home === NONE ? null : selectDestination(visitorPools, district, 'visitor', index, 9082026);
        if (visitor === null) stats.unplacedVisitor++;
        else { targets[index * 3 + 2] = visitor; roleCounts[visitor * 4 + 3]++; stats.visitor++; needed[visitor] = 1; offer(visitor, index); }
      }
    }
    targetShards.push({ ...await asset(output, `targets/${String(shard.startIndex).padStart(7, '0')}`, encodeTargetShard(shard.startIndex, targets.subarray(shard.startIndex * 3, (shard.startIndex + shard.count) * 3), buildingCount), true), startIndex: shard.startIndex, count: shard.count });
  }
  // Validate CSR membership against canonical records, not just equal totals.
  homes = null; districts = null;
  // Selection heaps/sets are no longer needed once all canonical assignments
  // have been offered. Compact before constructing the larger source graph.
  for (const [key, bucket] of cells) cells.set(key, Uint32Array.from(bucket.entries.map((entry) => entry.person).sort((a, b) => a - b)));
  const peopleView = new DataView(rawPeople.buffer); let seenMembers = new Uint8Array(personCount);
  for (let h = 0; h < householdCount; h++) for (let p = householdOffsets[h]; p < householdOffsets[h + 1]; p++) { const index = householdMemberIndices[p]; check(!seenMembers[index] && peopleView.getUint32(index * 16, true) === h, 'Household membership is not a partition of person records.'); seenMembers[index] = 1; }
  seenMembers = null;
  let householdTripMasks = new Uint8Array(personCount * 5);
  for (let h = 0; h < householdCount; h++) {
    if (!householdHasVehicle(h)) continue;
    const records = Array.from(householdMemberIndices.subarray(householdOffsets[h], householdOffsets[h + 1]), (p) => decodeEmbeddedPerson(p, rawPeople.subarray(p * 16, p * 16 + 16)));
    for (let scenario = 0; scenario < 3; scenario++) for (let year = 2026; year <= 2036; year++) {
      const trip = householdTripFor(records, year, SCENARIO_IDS[scenario]); if (!trip) continue;
      const bit = scenario * 11 + year - 2026;
      for (const p of trip.passengerIndices) householdTripMasks[p * 5 + (bit >>> 3)] |= 1 << (bit & 7);
    }
  }
  let offsets = new Uint32Array(roleCounts.length + 1); for (let i = 0; i < roleCounts.length; i++) offsets[i + 1] = offsets[i] + roleCounts[i];
  let members = new Uint32Array(offsets.at(-1)); let cursors = offsets.slice(0, -1);
  for (let person = 0; person < personCount; person++) for (let role = 0; role < 4; role++) { const building = role ? targets[person * 3 + role - 1] : personHomes[person]; if (building !== NONE) members[cursors[building * 4 + role]++] = person; }
  const roleShards = [];
  for (let first = 0; first < buildingCount; first += BUILDING_ROLE_SHARD_SIZE) {
    const count = Math.min(BUILDING_ROLE_SHARD_SIZE, buildingCount - first); const start = offsets[first * 4]; const end = offsets[(first + count) * 4];
    const localOffsets = offsets.slice(first * 4, (first + count) * 4 + 1); for (let i = 0; i < localOffsets.length; i++) localOffsets[i] -= start;
    const details = new Uint8Array((end - start) * 36); const view = new DataView(details.buffer); const tripMasks = new Uint8Array((end - start) * 5);
    for (let ordinal = start; ordinal < end; ordinal++) { const p = members[ordinal]; const position = (ordinal - start) * 36; view.setUint32(position, p, true); details.set(rawPeople.subarray(p * 16, p * 16 + 16), position + 4); view.setUint32(position + 20, personHomes[p], true); for (let r = 0; r < 3; r++) view.setUint32(position + 24 + r * 4, targets[p * 3 + r], true); tripMasks.set(householdTripMasks.subarray(p * 5, p * 5 + 5), (ordinal - start) * 5); }
    roleShards.push({ ...await asset(output, `roles/${String(first).padStart(6, '0')}`, encodeRoleShard(first, count, localOffsets, members.subarray(start, end), personCount), true), firstIndex: first, count, members: end - start, contexts: { ...await asset(output, `contexts/${String(first).padStart(6, '0')}`, details, true), recordBytes: 36, householdTripMasks: { ...await asset(output, `household-trip-masks/${String(first).padStart(6, '0')}`, tripMasks, true), recordBytes: 5 } } });
  }
  roleCounts = null; offsets = null; members = null; cursors = null; householdTripMasks = null;
  let roads = []; let roadBinding = { bindings: new Uint32Array(buildingCount * 2).fill(NONE), distances: new Float32Array(buildingCount * 2) };
  if (includeRoadBindings) { const index = JSON.parse(await verified(geoBase, geo.roadIndex)); check(index.contract === 'DemoRoadIndexV2' && index.roads.length === geo.roadIndex.count, 'Invalid road index.'); roads = index.roads; roadBinding = nearestRoadBindings(buildings, roads, needed); }
  const corridorBuilder = createRouteCorridorBuilder(roads, { maxCachedRoutes: 128 });
  for (let i = 0; i < roadBinding.bindings.length; i++) if (roadBinding.bindings[i] !== NONE) {
    const source = roadBinding.bindings[i]; const mode = i % 2 ? 'car' : 'walk';
    roadBinding.bindings[i] = corridorBuilder.build(roads[source].id, { mode }) ? source * 2 + i % 2 : NONE;
  }
  const roadSummary = (index) => { const sourceRoadIndex = index >>> 1; const mode = index % 2 ? 'car' : 'walk'; return { index, sourceRoadIndex, mode, ...corridorBuilder.build(roads[sourceRoadIndex].id, { mode }) }; };
  const bindingShards = []; let buildingsWithoutWalk = 0; let buildingsWithoutCar = 0;
  for (let first = 0; first < buildingCount; first += BUILDING_ROLE_SHARD_SIZE) {
    const count = Math.min(BUILDING_ROLE_SHARD_SIZE, buildingCount - first); const bindings = []; const roadIds = new Set();
    for (let building = first; building < first + count; building++) {
      if (!needed[building]) continue; const walk = roadBinding.bindings[building * 2]; const car = roadBinding.bindings[building * 2 + 1];
      if (walk === NONE) buildingsWithoutWalk++; else roadIds.add(walk); if (car === NONE) buildingsWithoutCar++; else roadIds.add(car);
      bindings.push([building, nullIndex(walk), nullIndex(car), walk === NONE ? null : Math.round(roadBinding.distances[building * 2]), car === NONE ? null : Math.round(roadBinding.distances[building * 2 + 1])]);
    }
    bindingShards.push({ ...await asset(output, `bindings/${String(first).padStart(6, '0')}`, { contract: 'DemoHomeRoadBindingsV2', firstIndex: first, count, bindings, roads: [...roadIds].sort((a, b) => a - b).map(roadSummary) }), firstIndex: first, count });
  }
  const candidateCells = [];
  const buildingSummary = (index) => { const b = buildings[index]; return { index, id: b[0], center: [b[1], b[2]], districtId: b[3], use: b[4], walkRoadIndex: nullIndex(roadBinding.bindings[index * 2]), carRoadIndex: nullIndex(roadBinding.bindings[index * 2 + 1]) }; };
  for (const [key, bucket] of [...cells].sort(([a], [b]) => a.localeCompare(b))) {
    const chosen = [...bucket]; const buildingIds = new Set(); const householdIds = new Set(); const roadIds = new Set();
    const people = chosen.map((p) => {
      const household = peopleView.getUint32(p * 16, true); householdIds.add(household); const home = personHomes[p]; const all = [home, targets[p * 3], targets[p * 3 + 1], targets[p * 3 + 2]]; for (const index of all) if (index !== NONE) { buildingIds.add(index); for (let mode = 0; mode < 2; mode++) { const road = roadBinding.bindings[index * 2 + mode]; if (road !== NONE) roadIds.add(road); } }
      const walk = home === NONE ? NONE : roadBinding.bindings[home * 2]; const car = home === NONE ? NONE : roadBinding.bindings[home * 2 + 1]; if (walk !== NONE) roadIds.add(walk); if (car !== NONE) roadIds.add(car);
      return [p, Buffer.from(rawPeople.subarray(p * 16, p * 16 + 16)).toString('base64'), household, ...all.map(nullIndex), nullIndex(walk), nullIndex(car)];
    });
    const households = [...householdIds].sort((a, b) => a - b).map((h) => [h, Array.from(householdMemberIndices.subarray(householdOffsets[h], householdOffsets[h + 1]), (p) => [p, Buffer.from(rawPeople.subarray(p * 16, p * 16 + 16)).toString('base64')])]);
    const payload = { contract: 'DemoSpatialCandidatesV2', key, representation: 'visual_synthesis', people, households, buildings: [...buildingIds].sort((a, b) => a - b).map(buildingSummary), roads: [...roadIds].sort((a, b) => a - b).map(roadSummary) };
    candidateCells.push({ ...await asset(output, `cells/${key}`, payload), key, count: people.length });
  }
  const sourceHashes = { populationManifest: sha(populationBytes), geographyManifest: sha(geoBytes), buildingIndex: geo.buildingIndex.sha256, roadIndex: geo.roadIndex?.sha256 ?? null, populationCodec: sha(await readFile(join(root, 'shared/demo-population/index.mjs'))), spatialCodec: sha(await readFile(join(root, 'shared/demo-population/spatial.mjs'))), routeCorridorCodec: sha(await readFile(join(root, 'shared/demo-population/route-corridors.mjs'))), compiler: sha(await readFile(fileURLToPath(import.meta.url))) };
  const manifest = { contract: 'DemoSpatialManifestV2', datasetId: DATASET_ID, representation: 'visual_synthesis', scientificClaim: false, recordCount: personCount, householdCount, buildingCount, targetShardSize: PERSON_SHARD_SIZE, targetRecordBytes: 12, roleShardSize: BUILDING_ROLE_SHARD_SIZE, sourceHashes, targetShards, roleShards, bindingShards, candidateCells, candidateCellZoom: 16, maxCellCandidates: MAX_CELL_CANDIDATES, stats: { ...stats, buildingsWithoutWalk, buildingsWithoutCar }, semantics: { targets: 'Lifetime potential candidates; filter with shared isActive/employmentFor/presenceFor. Counts are not simultaneous occupancy.', destinations: 'Same-district source-classified work/study buildings weighted by area*levels capped100000. Synthetic weights, no observed capacity or occupation compatibility.', unplaced: 'Missing home/district/eligible destination remains explicit null; no residential/unknown-use destination fallback.', visitors: 'One potential destination for each lifetime adult; source retail/shop/public-amenity eligibility; uncapped area*levels weighting, not measured footfall. Runtime age18+, same work/study priority, visits spread09:00-21:00 with conflicts moved after work/study.', candidates: `Deterministic ${MAX_CELL_CANDIDATES} smallest-hash candidates per potential home/destination z16 cell. Complete membership remains in role CSR. Not a full population download or census of visible people.`, candidateColumns: ['personIndex', 'personRecordBase64', 'householdIndex', 'homeBuildingIndex', 'workBuildingIndex', 'studyBuildingIndex', 'visitorBuildingIndex', 'walkRoadIndex', 'carRoadIndex'], rosterContexts: '36-byte rows aligned with role CSR member ordinal: uint32 personIndex,16 raw person bytes,uint32 home,uint32 work,uint32 study,uint32 visitor. NONE=4294967295. Little-endian.', routes: includeRoadBindings ? 'Nearest eligible source polyline within750m of each assigned building, walk/car separately, stable ID tie-break. Not a connected commute corridor; no invented building-to-road connector. Long-route movement criterion remains open.' : 'Road binding explicitly disabled; all route indices are null.' }, licenses: ['OpenStreetMap-derived geometry/indexes: ODbL-1.0; retain city-v2 source ledger and attribution.', 'Residents, work/study assignments and visits are fictional visual synthesis, not observations.'] };
  manifest.semantics.householdTrips = 'Shared fictional evening car outing, first active adult driver, at most7 active members; presenceFor uses full HH records. Roster companion5-byte rows encode participation in33 scenario-major/year2026-2036 contexts, reserved high7 bits zero.';
  manifest.semantics.routes = includeRoadBindings ? 'Nearest eligible source road within750m of each assigned building, extended along exact shared OSM node IDs into mode-eligible connected local presentation corridors. Target1km, maximum1.5km/12 split segments; dead ends and short paths explicit. Corridor ordinal=sourceRoadIndex*2+mode. No manufactured connector and not a calculated building-to-building commute.' : 'Road binding explicitly disabled; all route indices are null.';
  await mkdir(output, { recursive: true }); const bytes = `${JSON.stringify(manifest)}\n`; await writeFile(join(output, 'manifest.json.next'), bytes); await rename(join(output, 'manifest.json.next'), join(output, 'manifest.json'));
  return { manifestSha256: sha(bytes), recordCount: personCount, buildingCount, targets: targetShards.length, rosters: roleShards.length, candidateCells: candidateCells.length, stats: manifest.stats, maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  compileSpatial().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => { process.stderr.write('Spatial V2 compilation failed; inputs remain unchanged.\n'); process.exitCode = 1; });
}

/** Runtime-only manifest pin refresh; assignment source bytes must be identical. */
export async function refreshSpatialRuntimePin({ previousCodecPath, expectedManifestSha256, root = ROOT, output = join(root, 'apps/web/public/demo-v2/spatial') }) {
  const manifestPath = join(output, 'manifest.json'); const before = await readFile(manifestPath); const manifest = JSON.parse(before);
  check(sha(before) === expectedManifestSha256, 'Runtime pin refresh manifest changed.');
  const previousCodec = await readFile(previousCodecPath); const currentCodec = await readFile(join(root, 'shared/demo-population/spatial.mjs'));
  check(sha(previousCodec) === manifest.sourceHashes.spatialCodec, 'Previous runtime codec is not the pinned source.');
  const prefix = (bytes) => { const source = bytes.toString('utf8'); const at = source.search(/^(?:const roadMetrics =|\/\*\* Position on one pinned source polyline)/m); check(at > 0, 'Unsupported runtime-only source boundary.'); return source.slice(0, at).trimEnd(); };
  check(prefix(previousCodec) === prefix(currentCodec), 'Assignment or presence source changed; full compilation is required.');
  const compiler = await readFile(fileURLToPath(import.meta.url)); const compilerText = compiler.toString('utf8'); const boundary = compilerText.indexOf('\n/** Runtime-only manifest pin refresh;');
  check(boundary > 0 && sha(Buffer.from(compilerText.slice(0, boundary))) === manifest.sourceHashes.compiler, 'Compiler generation source changed; full compilation is required.');
  for (const [field, path] of [['populationManifest', 'apps/web/public/demo-v2/manifest.json'], ['geographyManifest', 'apps/web/public/city-v2/manifest.json'], ['populationCodec', 'shared/demo-population/index.mjs'], ['routeCorridorCodec', 'shared/demo-population/route-corridors.mjs']]) check(sha(await readFile(join(root, path))) === manifest.sourceHashes[field], 'Pinned assignment source changed.');
  const descriptors = []; const scan = (node) => { if (!node || typeof node !== 'object') return; if (node.url && Number.isInteger(node.bytes)) descriptors.push(node); for (const [key, value] of Object.entries(node)) if (key !== 'gzip') scan(value); }; scan(manifest);
  const { gunzipSync } = await import('node:zlib');
  for (const descriptor of descriptors) {
    let raw;
    if (descriptor.bytes === 0) { check(typeof descriptor.url === 'string' && !isAbsolute(descriptor.url) && !descriptor.url.split(/[\\/]/).includes('..'), 'Empty asset path escapes source directory.'); raw = await readFile(resolve(output, descriptor.url)); check(raw.length === 0 && sha(raw) === descriptor.sha256, 'Empty runtime asset hash mismatch.'); }
    else raw = await verified(output, descriptor);
    const compressed = await verified(output, descriptor.gzip); const decoded = gunzipSync(compressed); check(decoded.length === raw.length && sha(decoded) === descriptor.sha256, 'Runtime refresh asset content mismatch.');
  }
  manifest.sourceHashes.spatialCodec = sha(currentCodec); manifest.sourceHashes.compiler = sha(compiler);
  const after = Buffer.from(`${JSON.stringify(manifest)}\n`); await writeFile(`${manifestPath}.next`, after); await rename(`${manifestPath}.next`, manifestPath);
  return { manifestSha256: sha(after), spatialCodecSha256: sha(currentCodec), bytes: after.length, verifiedAssets: descriptors.length, assignmentPrefixUnchanged: true, allAssetBytesUnchanged: true };
}
