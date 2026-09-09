# Runtime tree appearance

The active city catalog contains no compiled large trees. `GameVegetation` reads
source landuse, landcover, park and explicit tree point features. In the recorded
MET and CEN views, every visible tree came from this runtime layer and every
placement was synthesized inside a source green polygon. Hiding only the runtime
group in an isolated browser removed those visible trees.

Explicit source point anchors keep their coordinates and IDs. Area-derived trees
use a deterministic world-cell candidate index with full-cell jitter and smooth
density variation. Candidate acceptance still requires the existing polygon-union,
hole, verified-building, source-road, additional-route and crown-separation checks.
No area outside a source polygon becomes greenery by this policy.

Each tree uses one continuous broad or upright canopy, a trunk and deterministic
aspect/tint variation. These are illustrative forms, not inferred species. Every
form stays within the previously cleared horizontal radius and vertical height.
Both canopy families share instanced meshes: at most three opaque draws, existing
128/512/900 tier caps and under1MiB retained allocation at the high tier. No texture,
compiler, catalog, canonical building or population source changes are required.

`node tools/qa-city-vegetation.mjs` opens its own Chromium context, captures MET/CEN
and hides the runtime group to establish attribution. Artifacts go to the operating
system temporary directory. Portable before/after evidence with relative names and
hashes is in `tree-appearance-evidence-2026-09-09.json`. These captures do not support
a performance claim and the simultaneous scene changes are explicitly recorded.
