import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import * as codec from '../../../shared/demo-population/index.mjs';
import * as spatial from '../../../shared/demo-population/spatial.mjs';
import { createPopulationResolver } from '../src/population-resolver.mjs';

// Offline verification of real generated public assets, never operator secrets,
// a cloud API, a production session or paid inference. Does not write files.
const directory = fileURLToPath(new URL('../../../apps/web/public/demo-v2/', import.meta.url));
const base = 'https://offline-verification.invalid/demo-v2/';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const population = await readFile(resolve(directory, 'manifest.json'));
const assignments = await readFile(resolve(directory, 'spatial/manifest.json'));
const codecHashes = {
  populationCodec: hash(await readFile(new URL('../../../shared/demo-population/index.mjs', import.meta.url))),
  spatialCodec: hash(await readFile(new URL('../../../shared/demo-population/spatial.mjs', import.meta.url))),
};
let filesRead = 0; let bytesRead = 0;
const resolver = createPopulationResolver({ populationUrl: `${base}manifest.json`, populationHash: hash(population), spatialUrl: `${base}spatial/manifest.json`, spatialHash: hash(assignments), codec, spatial, codecHashes,
  fetchImpl: async url => {
    assert.ok(String(url).startsWith(base));
    const path = resolve(directory, String(url).slice(base.length)); const suffix = relative(directory, path);
    assert.ok(suffix && !suffix.startsWith('..') && !isAbsolute(suffix));
    const bytes = await readFile(path); filesRead++; bytesRead += bytes.length;
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  },
});
let available = 0; let inactive = 0;
for (const index of [0, 588529, 1177057]) {
  for (const [scenario, year, minutes] of [['baseline', 2026, 600], ['inflow', 2031, 480], ['ageing', 2036, 1230]]) {
    const context = await resolver({ datasetId: codec.DATASET_ID, personId: codec.personId(index), scenario, year, presentationMinutes: minutes });
    if (!context) { inactive++; continue; }
    assert.equal(context.profile.id, codec.personId(index));
    assert.equal(context.profile.datasetId, codec.DATASET_ID); assert.equal(context.profile.isFictional, true);
    assert.ok(context.profile.householdSize > 0 && context.profile.householdSize <= 100);
    assert.equal(context.presence.active, true); assert.equal(context.presence.representation, 'visual_synthesis');
    available++;
  }
}
assert.ok(available >= 3);
console.log(JSON.stringify({ datasetId: codec.DATASET_ID, populationSha256: hash(population), spatialSha256: hash(assignments), checks: available + inactive, available, inactive, filesRead, bytesRead, networkRequests: 0, firestoreWrites: 0, inferenceCalls: 0, deployed: false }));
