import { createHash } from 'node:crypto';

export const POPULATION_LIMITS = Object.freeze({ maxManifestBytes: 2 * 1024 * 1024, maxShardBytes: 2 * 1024 * 1024, maxCacheBytes: 8 * 1024 * 1024, maxCacheEntries: 32, maxRequestAssets: 32, maxRequestBytes: 12 * 1024 * 1024, maxConcurrent: 2, timeoutMs: 10_000 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;

function manifestUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || !url.hostname.includes('.') || url.hostname === 'localhost') throw new Error('Invalid pinned population URL.');
  return url.href;
}
function assetUrl(value, base) {
  if (typeof value !== 'string' || value.length > 500 || !/^[a-zA-Z0-9_./-]+$/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid population asset path.');
  const url = new URL(value, base); const directory = new URL('.', base);
  if (url.origin !== directory.origin || !url.pathname.startsWith(directory.pathname)) throw new Error('Population asset escapes approved directory.');
  return url.href;
}
function table(rows, total, shardSize, base, maxBytes, exactStride) {
  if (!Array.isArray(rows) || rows.length !== Math.ceil(total / shardSize)) throw new Error('Invalid population shard table.');
  return rows.map((row, i) => {
    const count = Math.min(shardSize, total - i * shardSize);
    if (row.startIndex !== i * shardSize || row.count !== count || !digest(row.sha256) || !integer(row.bytes, maxBytes) || row.bytes < 32 || exactStride && row.bytes !== 32 + count * exactStride) throw new Error('Invalid population shard descriptor.');
    return Object.freeze({ url: assetUrl(row.url, base), sha256: row.sha256, bytes: row.bytes, startIndex: row.startIndex, count });
  });
}

/** Read only exact server-pinned HTTPS assets. Request input never chooses URLs. */
export function createPopulationResolver({ populationUrl, populationHash, spatialUrl, spatialHash, codec, spatial, codecHashes, fetchImpl = fetch, limits: overrides = {} }) {
  populationUrl = manifestUrl(populationUrl); spatialUrl = manifestUrl(spatialUrl);
  if (new URL(populationUrl).origin !== new URL(spatialUrl).origin || !digest(populationHash) || !digest(spatialHash) || !digest(codecHashes?.populationCodec) || !digest(codecHashes?.spatialCodec)) throw new Error('Invalid pinned population configuration.');
  const limits = { ...POPULATION_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw new Error('Invalid population resolver limit.');
    limits[key] = value;
  }
  const profileHash = sha256(JSON.stringify({ populationHash, spatialHash, ...codecHashes }));
  const cache = new Map(); let cacheBytes = 0; let manifests; let concurrent = 0;
  function cached(key) {
    const value = cache.get(key);
    if (value) { cache.delete(key); cache.set(key, value); }
    return value?.decoded;
  }
  function retain(key, decoded, bytes) {
    if (bytes > limits.maxCacheBytes) return;
    while (cache.size && (cache.size >= limits.maxCacheEntries || cacheBytes + bytes > limits.maxCacheBytes)) {
      const oldest = cache.keys().next().value; cacheBytes -= cache.get(oldest).bytes; cache.delete(oldest);
    }
    const previous = cache.get(key);
    if (previous) cacheBytes -= previous.bytes;
    cache.set(key, { decoded, bytes }); cacheBytes += bytes;
  }
  async function verified(url, hash, expectedBytes, maximum, request) {
    if (request.signal.aborted) throw new Error('Population request expired.');
    if (++request.assets > limits.maxRequestAssets) throw new Error('Population request asset budget exceeded.');
    const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', signal: request.signal });
    if (!response.ok || response.redirected || !response.body) { await response.body?.cancel(); throw new Error('Population asset unavailable.'); }
    const length = response.headers.get('content-length');
    // Content-Length can describe the compressed transport, while fetch yields
    // decoded bytes. Exact descriptor length and SHA are checked on that stream.
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) { await response.body.cancel(); throw new Error('Invalid population response size.'); }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      for (;;) {
        if (request.signal.aborted) throw new Error('Population request expired.');
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; request.bytes += value.byteLength;
        if (size > maximum || expectedBytes !== null && size > expectedBytes || request.bytes > limits.maxRequestBytes) throw new Error('Population response size or request byte budget exceeded.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks, size);
    if (expectedBytes !== null && size !== expectedBytes || sha256(bytes) !== hash) throw new Error('Population asset digest or size mismatch.');
    return bytes;
  }
  async function approvedManifests(request) {
    if (manifests) return manifests;
    const population = JSON.parse((await verified(populationUrl, populationHash, null, limits.maxManifestBytes, request)).toString('utf8'));
    const assignment = JSON.parse((await verified(spatialUrl, spatialHash, null, limits.maxManifestBytes, request)).toString('utf8'));
    if (population.contract !== 'DemoPopulationManifestV2' || population.datasetId !== codec.DATASET_ID || population.representation !== 'fictional_demo' || population.scientificClaim !== false || population.predictiveValidation !== false || population.startYear !== codec.BASE_YEAR || population.endYear !== codec.END_YEAR || !integer(population.recordCount, 10_000_000) || !population.recordCount || !integer(population.householdCount, 10_000_000) || !population.householdCount || population.personShardSize !== codec.PERSON_SHARD_SIZE || population.householdShardSize !== codec.HOUSEHOLD_SHARD_SIZE || population.provenance?.sourceHashes?.codec !== codecHashes.populationCodec) throw new Error('Invalid approved population manifest.');
    if (!digest(population.spatial?.geographyManifestSha256) || !digest(population.spatial?.buildingIndex?.sha256) || assignment.contract !== 'DemoSpatialManifestV2' || assignment.datasetId !== codec.DATASET_ID || assignment.representation !== 'visual_synthesis' || assignment.recordCount !== population.recordCount || assignment.targetShardSize !== codec.PERSON_SHARD_SIZE || !integer(assignment.buildingCount, 9_999_999) || !assignment.buildingCount || assignment.buildingCount !== population.spatial?.buildingIndex?.count || assignment.sourceHashes?.populationManifest !== populationHash || assignment.sourceHashes?.populationCodec !== codecHashes.populationCodec || assignment.sourceHashes?.spatialCodec !== codecHashes.spatialCodec || assignment.sourceHashes?.geographyManifest !== population.spatial?.geographyManifestSha256 || assignment.sourceHashes?.buildingIndex !== population.spatial?.buildingIndex?.sha256) throw new Error('Invalid approved spatial binding.');
    const territories = new Map();
    if (!Array.isArray(population.territories) || population.territories.length > 8) throw new Error('Invalid approved territories.');
    for (const row of population.territories) {
      if (!['RU-CHE-SET', ...codec.DISTRICT_IDS].includes(row.id) || territories.has(row.id) || typeof row.name !== 'string' || !row.name.length || row.name.length > 100) throw new Error('Invalid approved territory.');
      territories.set(row.id, row.name);
    }
    if (!territories.has('RU-CHE-SET')) throw new Error('Missing approved city.');
    manifests = Object.freeze({ recordCount: population.recordCount, householdCount: population.householdCount, buildingCount: assignment.buildingCount, territories,
      people: table(population.personShards, population.recordCount, codec.PERSON_SHARD_SIZE, populationUrl, limits.maxShardBytes, codec.RECORD_BYTES),
      households: table(population.householdShards, population.householdCount, codec.HOUSEHOLD_SHARD_SIZE, populationUrl, limits.maxShardBytes),
      targets: table(assignment.targetShards, population.recordCount, codec.PERSON_SHARD_SIZE, spatialUrl, limits.maxShardBytes, spatial.TARGET_RECORD_BYTES),
    });
    return manifests;
  }
  async function shard(descriptor, decoder, request) {
    if (!descriptor) throw new Error('Missing population shard.');
    const key = `${descriptor.url}:${descriptor.sha256}`; const ready = cached(key); if (ready) return ready;
    const bytes = await verified(descriptor.url, descriptor.sha256, descriptor.bytes, limits.maxShardBytes, request);
    const decoded = decoder(bytes);
    if (decoded.startIndex !== descriptor.startIndex || decoded.count !== descriptor.count) throw new Error('Population shard range mismatch.');
    retain(key, decoded, bytes.length); return decoded;
  }
  const resolveProfile = async (query, { signal: outerSignal } = {}) => {
    const index = codec.parsePersonId(query?.personId);
    if (query?.datasetId !== codec.DATASET_ID || index === null || !codec.SCENARIO_IDS.includes(query.scenario) || !Number.isInteger(query.year) || query.year < codec.BASE_YEAR || query.year > codec.END_YEAR || !Number.isFinite(query.presentationMinutes) || query.presentationMinutes < 0 || query.presentationMinutes >= 1440) return null;
    if (concurrent >= limits.maxConcurrent) throw new Error('Population resolver busy.');
    concurrent++;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
    const request = { signal, assets: 0, bytes: 0 };
    try {
      const m = await approvedManifests(request); if (index >= m.recordCount) return null;
      const person = async member => {
        if (!integer(member, m.recordCount - 1)) throw new Error('Invalid approved household member.');
        return codec.recordAt(await shard(m.people[Math.floor(member / codec.PERSON_SHARD_SIZE)], codec.decodePersonShard, request), member);
      };
      const record = await person(index);
      if (!codec.isActive(record, query.year, query.scenario)) return null;
      if (!integer(record.householdIndex, m.householdCount - 1)) throw new Error('Invalid resident household.');
      const household = codec.householdMembers(await shard(m.households[Math.floor(record.householdIndex / codec.HOUSEHOLD_SHARD_SIZE)], codec.decodeHouseholdShard, request), record.householdIndex);
      if (!household.members.length || !household.members.includes(index) || new Set(household.members).size !== household.members.length || household.homeBuildingIndex !== null && !integer(household.homeBuildingIndex, m.buildingCount - 1)) throw new Error('Invalid approved household membership or home.');
      let householdSize = 0; const householdRecords = [];
      for (const member of household.members) {
        const relative = await person(member);
        if (relative.householdIndex !== record.householdIndex) throw new Error('Household reverse membership mismatch.');
        householdRecords.push(relative);
        if (codec.isActive(relative, query.year, query.scenario)) householdSize++;
      }
      const targetShard = await shard(m.targets[Math.floor(index / codec.PERSON_SHARD_SIZE)], spatial.decodeTargetShard, request);
      if (targetShard.extra !== m.buildingCount) throw new Error('Target building range mismatch.');
      const targets = spatial.targetAt(targetShard, index);
      const territoryId = household.districtIndex === null ? 'RU-CHE-SET' : codec.DISTRICT_IDS[household.districtIndex];
      const territoryName = m.territories.get(territoryId);
      if (!territoryName) throw new Error('Missing approved household territory.');
      const profile = codec.profileFor(record, query.year, query.scenario, { householdSize, territoryId, territoryName });
      const presence = spatial.presenceFor(record, targets, household.homeBuildingIndex, query.year, query.scenario, query.presentationMinutes, { householdRecords });
      if (signal.aborted) throw new Error('Population request expired.');
      return { profile, presence: { ...presence, representation: 'visual_synthesis' }, profileHash };
    } finally { clearTimeout(timer); concurrent--; }
  };
  // This revision is known without network I/O, so durable admission can reserve
  // an attempt before any remote manifest/shard access. It cannot be reassigned.
  return Object.defineProperty(resolveProfile, 'profileHash', { value: profileHash, enumerable: true });
}
