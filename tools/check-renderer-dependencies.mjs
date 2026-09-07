/** Prevent a valid npm tree from shipping two incompatible global luma singletons. */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const lock = JSON.parse(await readFile(resolve(process.argv[2] ?? 'package-lock.json'), 'utf8'));
assert.equal(lock.lockfileVersion, 3, 'Renderer dependency check requires npm lockfile v3');
const families = { luma: new Map(), deck: new Map() };
for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
  const match = /(?:^|\/)node_modules\/(@(?:luma|deck)\.gl\/[^/]+)$/.exec(path);
  if (!match) continue;
  const name = match[1];
  const family = name.startsWith('@luma.') ? families.luma : families.deck;
  const entries = family.get(name) ?? [];
  entries.push({ path, version: pkg.version });
  family.set(name, entries);
}
for (const [label, family] of Object.entries(families)) {
  assert.ok(family.size, `Missing ${label}.gl dependency family`);
  const minors = new Set();
  for (const [name, entries] of family) {
    const versions = new Set(entries.map(entry => entry.version));
    assert.equal(versions.size, 1, `${name} has incompatible installed versions: ${JSON.stringify(entries)}`);
    for (const version of versions) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must resolve to an exact stable version`);
      minors.add(version.split('.').slice(0, 2).join('.'));
    }
  }
  assert.equal(minors.size, 1, `${label}.gl family mixes major/minor versions: ${[...minors].join(', ')}`);
  const core = family.get(`@${label}.gl/core`);
  assert.equal(core?.length, 1, `${label}.gl core must be a single installed instance: ${JSON.stringify(core)}`);
}
const lumaMinor = families.luma.get('@luma.gl/core')[0].version.split('.').slice(0, 2).join('.');
const deckMinor = families.deck.get('@deck.gl/core')[0].version.split('.').slice(0, 2).join('.');
assert.equal(lumaMinor, deckMinor, 'The approved deck/luma pairing must share the same major/minor');
console.log(JSON.stringify({ status: 'coherent_singletons', luma: Object.fromEntries([...families.luma].map(([name, entries]) => [name, entries[0].version])), deck: Object.fromEntries([...families.deck].map(([name, entries]) => [name, entries[0].version])) }, null, 2));
