# Third-party resources and retained rights

Project code is published at the owner's request. The inherited OmniTwin code,
new demo code, authored fictional records and owner-supplied assets are **not
assigned a default MIT or other open-source license by this notice**. Third-party
licenses apply to their respective components independently; public repository
access alone does not grant a new project-wide license.

## Browser distribution notices

Complete copyright, license and NOTICE texts are shipped with the site in
[`apps/web/public/THIRD_PARTY_LICENSES.txt`](apps/web/public/THIRD_PARTY_LICENSES.txt).
The accompanying [machine-readable inventory](apps/web/public/third-party-license-inventory.json)
records package versions, source files and hashes. It conservatively covers the
frontend lockfile's production dependency closure, including transitive packages
that may later be removed by tree shaking. It includes, among others, React,
MapLibre GL JS, deck.gl/luma.gl, Three.js, Lucide/Feather, PMTiles and their
dependencies. It is not merely a list of SPDX license labels.

Regenerate with `node tools/build-license-notices.mjs` after a clean `npm ci` and
before the web build. Installed dependencies are read-only; generation makes no
network requests and fails if a production package lacks a complete notice.
Explicit reviewed snapshots cover npm packages which omit their license file;
their primary-source provenance is preserved in the inventory. Build/test-only
tools and the independently deployed chat server are outside this browser bundle
inventory. The server's dependencies retain their own notices when installed
from its separate lockfile.

## Map, style, fonts and visual assets

- Vector data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
  [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Source vector tiles
  remain unmodified. The derived street/building display layout is also provided
  under the applicable ODbL terms, together with source provenance and builder.
- Map service and schema: [OpenFreeMap](https://openfreemap.org/) /
  [OpenMapTiles](https://openmaptiles.org/). The local, pinned tile pack covers
  only a bounded Chelyabinsk centre; it is not a complete offline city or country.
  Outside its coverage, the explicitly declared online source is used. See
  [city sources](apps/web/public/city/SOURCES.md) and
  [the pinned manifest](apps/web/public/city/manifest.json).
- The separate municipal V2 geography database covers the actual Chelyabinsk
  municipal OSM boundary and seven source district relations, with real tagged
  footprints and road topology. It is distributed under ODbL 1.0, not the
  project's authored-code/fictional-record terms. Its immutable z16 cells and
  source/version/hash ledger are documented in
  [V2 geography sources](apps/web/public/city-v2/SOURCES.md). It expands display
  assignment coverage, not offline basemap coverage. Unknown building uses and
  unmatched district coverage remain explicit; capacity and resident assignments
  are visual synthesis. No CDO or fabricated district geometry is redistributed.
- Style lineage: OpenFreeMap Liberty → OSM Liberty → OSM Bright / Mapbox Open
  Styles. Upstream style code retains its BSD/MIT notices; design attribution
  includes [Mapbox Open Styles, CC BY 3.0](https://github.com/mapbox/mapbox-gl-styles/blob/master/LICENSE.md)
  and [OpenMapTiles, CC BY 4.0](https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md).
  Demo changes are local asset URLs, restrained palette and building-layer
  presentation. The relevant upstream notices are retained in the public text
  bundle; visible OpenStreetMap/OpenMapTiles/OpenFreeMap map attribution remains.
- Local Noto Sans glyphs: SIL Open Font License 1.1. Local OpenFreeMap sprites
  include Maki icons under CC0 1.0. No proprietary Arial font or Mapbox imagery is
  included merely because an upstream historical style notice mentions it.
- Solar calculation: adapted SunCalc 2.0.1, BSD-2-Clause. Its notice and the Noto
  and OpenFreeMap notices remain under `assets/living-city/licenses/` and are also
  included in the consolidated public notices.
- Existing OmniTwin material/actor atlases are owner-authored visual synthesis,
  not surveyed textures or claims about actual occupants or vegetation.
- The shared atlas of eight adult profile portraits was AI-generated with the
  built-in image-generation tool on 2026-09-07. These are illustrative archetypes,
  not photographs, real identities or unique depictions of every resident.
  Minors use a generic icon. [Provenance and the generation prompt](docs/VISUAL_ASSETS.md)
  and [the public atlas manifest](apps/web/public/demo/portrait-atlas-v1.json) are
  retained. This notice does not invent a redistribution license for the asset.
- The white RUDN PNG was supplied by the author for this demonstration. This
  notice grants no university-brand redistribution license and implies no
  university endorsement. Further use requires the relevant rights.
- Public people and demographic scenarios are authored deterministic fictional
  interface examples. They are not real person records, restricted scientific
  microdata, calibrated results or validated forecasts.
