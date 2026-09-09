import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMovementPage, movementContextAt, decodeMovementCellContext } from '../movement-index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const spatialDirectory = resolve(root, 'apps/web/public/demo-v2/spatial');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asset = async (base, descriptor) => { const bytes = await readFile(resolve(base, descriptor.url)); assert.equal(bytes.length, descriptor.bytes); assert.equal(hash(bytes), descriptor.sha256); return bytes; };

test('full movement manifest closes additive lineage without changing canonical sources', async (t) => {
  let spatial; try { spatial = JSON.parse(await readFile(resolve(spatialDirectory, 'manifest.json'))); } catch (error) { if (error.code === 'ENOENT') return t.skip('Compile spatial artifacts first.'); throw error; }
  if (!spatial.movementIndex) return t.skip('Compile the additive movement index first.');
  const bytes = await asset(spatialDirectory, spatial.movementIndex); const movement = JSON.parse(bytes);
  assert.equal(movement.contract, 'DemoMovementIndexManifestV2'); assert.equal(movement.recordCount, spatial.recordCount); assert.ok(bytes.length <= 8 * 1024 * 1024);
  const base = { ...spatial }; delete base.movementIndex; assert.equal(hash(`${JSON.stringify(base)}\n`), movement.sourceHashes.baseSpatialManifest);
  for (const key of ['populationManifest', 'geographyManifest', 'buildingIndex', 'populationCodec', 'spatialCodec', 'routeCorridorCodec']) assert.equal(movement.sourceHashes[key], spatial.sourceHashes[key]);
  assert.equal(movement.sourceHashes.codec, hash(await readFile(resolve(root, 'shared/demo-population/movement-index.mjs'))));
  assert.equal(movement.sourceHashes.compiler, hash(await readFile(resolve(root, 'tools/build-city-movement-index-v2.mjs'))));
  const keys = new Set(); let rows = 0; let pages = 0;
  for (const cell of movement.cells) {
    assert.ok(!keys.has(cell.key)); keys.add(cell.key); let count = 0; let previous = -1;
    assert.equal(cell.bbox.length, 4); assert.ok(cell.bbox.every(Number.isFinite)); assert.ok(cell.bbox[0] < cell.bbox[2] && cell.bbox[1] < cell.bbox[3]);
    for (const page of cell.pages) { assert.ok(page.count > 0 && page.count <= movement.pageSize); assert.ok(page.firstPersonIndex > previous && page.lastPersonIndex >= page.firstPersonIndex); assert.ok(page.bytes <= 8 * 1024 * 1024); previous = page.lastPersonIndex; count += page.count; pages++; }
    assert.equal(count, cell.count); rows += count;
  }
  assert.equal(rows, movement.stats.uniqueAssociations); assert.equal(pages, movement.stats.pages); assert.equal(keys.size, movement.stats.cells);
  assert.ok(rows > 14_000_000 && rows <= movement.stats.expandedAssociations);
  t.diagnostic(JSON.stringify({ spatialSha256: hash(`${JSON.stringify(spatial)}\n`), movementSha256: hash(bytes), cells: keys.size, pages, uniquePersonCellAssociations: rows }));
});

test('three bounded real movement pages keep complete households and canonical origin modes', async (t) => {
  let spatial; try { spatial = JSON.parse(await readFile(resolve(spatialDirectory, 'manifest.json'))); } catch (error) { if (error.code === 'ENOENT') return t.skip('Compile spatial artifacts first.'); throw error; }
  if (!spatial.movementIndex) return t.skip('Compile the additive movement index first.');
  const movement = JSON.parse(await asset(spatialDirectory, spatial.movementIndex)); const directory = dirname(resolve(spatialDirectory, spatial.movementIndex.url));
  for (const cell of [...movement.cells].sort((a, b) => b.count - a.count).slice(0, 3)) {
    const bindings = decodeMovementCellContext(await asset(directory, cell.context)); const origins = new Map(bindings.bindings.map((binding) => [binding[0], binding])); const roads = new Map(bindings.roads.map((road) => [road.index, road]));
    const descriptor = cell.pages[0]; const decoded = decodeMovementPage(await asset(directory, descriptor)); assert.equal(decoded.count, descriptor.count); assert.equal(decoded.key, cell.key);
    assert.equal(movementContextAt(decoded, 0).record.personIndex, descriptor.firstPersonIndex); assert.equal(movementContextAt(decoded, decoded.count - 1).record.personIndex, descriptor.lastPersonIndex);
    for (let ordinal = 0; ordinal < decoded.count; ordinal++) {
      const context = movementContextAt(decoded, ordinal); assert.ok(context.householdRecords.some((record) => record.personIndex === context.record.personIndex)); assert.ok(context.householdRecords.every((record) => record.householdIndex === context.record.householdIndex));
      const possibleOrigins = [context.homeBuildingIndex, ...Object.values(context.targets)]; assert.ok(possibleOrigins.some((index) => origins.has(index)));
      for (const index of possibleOrigins) { const binding = origins.get(index); if (!binding) continue; assert.ok(binding[1] === null || roads.get(binding[1]).mode === 'walk'); assert.ok(binding[2] === null || roads.get(binding[2]).mode === 'car'); }
    }
  }
});
