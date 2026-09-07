/** Reproducible public notices. Reads installed packages; never modifies them. */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installationArgument = process.argv.slice(2).find((value) => value.startsWith('--installed-root='));
assert.ok(process.argv.slice(2).every((value) => value === installationArgument), 'Unsupported license-generation argument');
const installedRoot = installationArgument ? resolve(installationArgument.slice('--installed-root='.length)) : root;
const publicRoot = resolve(root, 'apps/web/public');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const reviewDate = '2026-09-07';

// Three npm distributions omit their license files. These are explicit reviewed
// primary-source snapshots, not a guessed generic license or network CI fallback.
const deanNotice = `The MIT License (MIT)

Copyright © 2026 Dean Landolt <dean@deanlandolt.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`;
const pmtilesNotice = `The below license (BSD-3) applies to the reference implementations in this repository.

The PMTiles specification itself is public domain, or CC0 where applicable.

Sample tilesets available in this repository are subject to their own license terms.

---

Copyright 2021 Protomaps LLC

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;
const missingFileOverrides = {
  'bytewise@1.1.0': { text: deanNotice, url: 'https://deanlandolt.mit-license.org/', note: 'Installed README explicitly links this author-specified MIT notice. Snapshot 2026-09-07; 2026 is the linked page display year, not an assertion of the original package creation year.' },
  'typewise@1.0.3': { text: deanNotice, url: 'https://deanlandolt.mit-license.org/', note: 'Installed README explicitly links this author-specified MIT notice. Snapshot 2026-09-07; 2026 is the linked page display year, not an assertion of the original package creation year.' },
  'pmtiles@4.5.0': { text: pmtilesNotice, url: 'https://github.com/protomaps/PMTiles/blob/3b10e67edb65c6b04549f74c0279cef8328d859c/LICENSE', note: 'License at the npm distribution gitHead; package metadata declares BSD-3-Clause.' },
};

const mapboxStyleNotice = `This document sets forth the licenses under which the design and code in this repository (collectively, the "Mapbox Open Styles") are made available.  Mapbox Open Styles are copyright (c) 2014, Mapbox, all rights reserved.

# Code License

The Mapbox GL Style JSON files in this repository and the code therein are licensed under the BSD license:

> Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

> * Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
* Neither the name of Mapbox nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

# Design License

The visual design features of the Mapbox Open Styles (also known as the "look and feel" of the map) are licensed under the Creative Commons Attribution 3.0 license. To view a copy of the license, visit http://creativecommons.org/licenses/by/3.0/. Attribution need not be provided on map images, but should be reasonably accessable from maps based on on these styles (for example, in a webpage linked from copyright notice on the map).

Copyright, database rights, and any other intellectual property or proprietary rights in vector tiles, satellite or aerial imagery, and any other map data and map data offered by Mapbox for use with the Mapbox Open Styles are expressly excluded from this license.

# Fonts and sprites

The Mapbox Open Styles use the following font families:

- Open Sans, digitized data(c) 2010-2011, Google Corporation. Open Sans is licensed under the Apache License, Version 2.0. You may obtain a copy of the license at http://www.apache.org/licenses/LICENSE-2.0.
- Arial Unicode MS, digitized data (c) 1993-2000 Agfa Monotype Corporation. All rights reserved. If you use the Mapbox Open Styles with the Mapbox service, your use of Arial Unicode is licensed. Otherwise, you may need a license.

Mapbox waives all copyright in the SVG icons in this repository used in the Mapbox Open Styles, under the terms of the CC0 v 1.0 Public Domain Dedication. You may obtain a copy of the dedication at http://creativecommons.org/publicdomain/zero/1.0/.

THE STYLES ARE PROVIDED "AS IS" AND WE HEREBY DISCLAIM ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY, AND FITNESS FOR A PARTICULAR PURPOSE. IN NO EVENT SHALL WE BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

This document is effective for all styles in the repository as of May 3, 2016 (excluding prior history maintained in the repository).
`;

const lockBytes = await readFile(resolve(root, 'package-lock.json'));
if (installedRoot !== root) assert.equal(sha(await readFile(resolve(installedRoot, 'package-lock.json'))), sha(lockBytes), 'Alternate clean installation has a different lockfile');
const lock = JSON.parse(lockBytes);
const packages = [];
const sections = [
  'OmniTwin Demo — third-party production dependency license notices',
  `Review date: ${reviewDate}`,
  'Scope: installed third-party packages marked production-reachable by the frontend workspace lockfile. This is a conservative declared-dependency closure, not a claim that every listed package survives tree shaking. Build/test-only packages and the separately deployed server are outside this browser-distribution scope.',
  'OmniTwin project code, fictional data and owner-supplied brand assets are NOT relicensed under the licenses below. The original owners retain their applicable rights.',
  'Most texts are copied without substantive changes from installed LICENSE/COPYING/NOTICE files. One MIT notice is extracted from the installed README. Three missing-file packages use explicit, sourced primary-license snapshots recorded in the inventory. No network access occurs while generating this file.',
];
for (const [packagePath, metadata] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!packagePath.includes('node_modules/') || metadata.dev || metadata.devOptional || metadata.link) continue;
  const directory = resolve(installedRoot, packagePath);
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  assert.equal(pkg.version, metadata.version, `Installed version mismatch: ${packagePath}`);
  const key = `${pkg.name}@${pkg.version}`;
  const names = [];
  for (const name of (await readdir(directory)).sort()) {
    if (/^(?:licen[sc]e|copying|notice)(?:$|[._-])/i.test(name) && (await stat(resolve(directory, name))).isFile()) names.push(name);
  }
  const notices = [];
  for (const name of names) notices.push({ text: await readFile(resolve(directory, name), 'utf8'), path: `${packagePath}/${name}`, kind: 'installed_license_file' });
  if (notices.length === 0 && key === 'murmurhash-js@1.0.0') {
    const source = await readFile(resolve(directory, 'README.md'), 'utf8');
    const start = source.indexOf('## License (MIT)');
    assert.ok(start >= 0 && source.slice(start).includes('Permission is hereby granted'), 'MurmurHash README license missing');
    notices.push({ text: source.slice(start), path: `${packagePath}/README.md#license-mit`, kind: 'installed_readme_license_section' });
  }
  if (notices.length === 0 && missingFileOverrides[key]) {
    const override = missingFileOverrides[key];
    notices.push({ text: override.text, path: 'tools/build-license-notices.mjs', kind: 'reviewed_primary_source_snapshot', sourceUrl: override.url, note: override.note });
  }
  assert.ok(notices.length > 0 && notices.every((notice) => notice.text.length > 100), `Full license text missing: ${key}`);
  const license = typeof pkg.license === 'string' ? pkg.license : metadata.license;
  sections.push(`\n${'='.repeat(78)}\n${key}\nDeclared license: ${license}\nPackage path: ${packagePath}`);
  for (const notice of notices) sections.push(`\nSource: ${notice.sourceUrl ?? notice.path}${notice.note ? `\nNote: ${notice.note}` : ''}\n\n${notice.text.trimEnd()}\n`);
  packages.push({ name: pkg.name, version: pkg.version, declaredLicense: license, packagePath, notices: notices.map(({ text, ...record }) => ({ ...record, sha256: sha(text) })) });
}
assert.ok(packages.length > 50, 'Unexpectedly incomplete production dependency inventory');
const assetPaths = ['assets/living-city/licenses/NotoSans-OFL-1.1.txt', 'assets/living-city/licenses/OpenFreeMap-LICENSE.md', 'assets/living-city/licenses/SUNCALC-BSD-2-CLAUSE.txt'];
const assets = [];
for (const path of assetPaths) {
  const text = await readFile(resolve(publicRoot, path), 'utf8');
  assets.push({ path, sha256: sha(text), kind: 'retained_asset_license' });
  sections.push(`\n${'='.repeat(78)}\nAsset notice: ${path}\n\n${text.trimEnd()}\n`);
}
sections.push(`\n${'='.repeat(78)}\nInherited Mapbox Open Styles license (through OSM Bright → OSM Liberty → OpenFreeMap Liberty)\nSource: https://github.com/mapbox/mapbox-gl-styles/blob/master/LICENSE.md\nSnapshot reviewed: ${reviewDate}\nNote: this is the complete upstream historical notice. Its discussion of Arial, Open Sans and Mapbox imagery does NOT mean those assets are included here; this demo ships the separately noticed Noto Sans glyphs. Demo modifications: local asset URLs and restrained palette/building-layer presentation.\n\n${mapboxStyleNotice}`);
const result = `${sections.join('\n\n')}\n`;
const inventory = { contract: 'DemoThirdPartyLicenseInventoryV1', reviewedAt: reviewDate, scope: 'frontend_lockfile_production_dependency_closure_and_retained_assets', lockfile: 'package-lock.json', lockfileSha256: sha(lockBytes), packageCount: packages.length, packages, assets, additionalSourceSnapshots: [{ name: 'Inherited Mapbox Open Styles', sourceUrl: 'https://github.com/mapbox/mapbox-gl-styles/blob/master/LICENSE.md', sha256: sha(mapboxStyleNotice) }], noticeFile: 'THIRD_PARTY_LICENSES.txt', noticeSha256: sha(result), missingLicenses: [] };
await writeFile(resolve(publicRoot, 'THIRD_PARTY_LICENSES.txt'), result);
await writeFile(resolve(publicRoot, 'third-party-license-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
console.log(JSON.stringify({ packageCount: packages.length, noticeBytes: Buffer.byteLength(result), noticeSha256: inventory.noticeSha256, missingLicenses: 0, networkRequests: 0 }));
