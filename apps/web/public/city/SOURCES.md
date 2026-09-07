# Bounded Chelyabinsk demo map pack

This is a small, unmodified selection of OpenFreeMap OpenMapTiles vector tiles,
not a complete city map and not a national offline archive. The exact dataset
version, source URL, tile coordinates, content hashes and coverage rectangle are
recorded in `manifest.json`. The pack contains 25 z14 tiles and their necessary
z10–13 ancestors. Rendering outside its coverage uses the declared streaming source.

Map data is from **OpenStreetMap contributors**, licensed under the
[Open Database License (ODbL) 1.0](https://www.openstreetmap.org/copyright).
Preserve visible attribution to **OpenStreetMap** and **OpenMapTiles**.
[OpenFreeMap](https://openfreemap.org/) provides the source service and documents
self-hosting support, commercial use and the unmodified OpenMapTiles schema.

The source data is not a population model. `layout-*.json` is a reproducible
display-only extraction of actual footprint IDs and road polylines. It neither
asserts real household addresses nor invents missing buildings, sidewalks or
road links. Very low source structures are omitted from residential assignment
but remain untouched in the vector tiles themselves.

Rebuild with `node tools/build-city-pack.mjs` using Node 22.18+ and installed
`@mapbox/vector-tile` / `pbf`. The default verifies and reuses the pinned local
files; `--refresh` explicitly selects the current upstream dataset. Fetching is
serial and restricted to at most 49 tiles / 20 MiB. A normal offline rebuild does
not contact OpenFreeMap when all pinned tiles are intact.
