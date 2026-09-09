# Bounded building art v3

The independent courtyard screenshot shows a long bare roof with its eight old
equipment boxes concentrated near one end, a roof-level parapet line, and repeated
flat window cards. This change is visual synthesis, not an observation of roofs.

Plan: first characterize those defects in focused compiler tests; distribute
bounded, varied equipment over each source roof, add readable parapet upstands,
use distinct family window profiles with bounded physical recesses and entrance
detail; verify canonical ownership, unchanged source heights/footprints/holes,
metric material density, deterministic generation and coarse geometry limits.

This task changes only building assembly/detail helpers and focused tests. The
existing CC0 material library remains shared. No population/route source changes,
full-city rebuild, public activation or cloud operation are included. Root owns
the bounded scene rebuild and final GPU/screenshot review before any city freeze.

Implemented and checked: four equipment forms use one existing metal material;
farthest-first candidate selection covers the full source roof. Near geometry is
capped at 24 groups / 2,400 triangles; far uses the same first eight placements /
240 triangles. Clearance tests include every cap and complete equipment envelope,
including concavities and source courtyard holes. No roof fixture exceeds the
source roof plane by two metres. The synthesized parapet rises 0.39 m above it;
the roof plane, source height metadata and footprint remain unchanged.

Eight families now have metre-based window proportions and reveals. At most 256
near windows use real wall apertures with glass recessed 0.12–0.24 m; tests show
the source wall no longer occludes those openings. Existing window materials
carry three stable mullion/brightness patterns. Four entrance maximum, 80 balcony
maximum and 64 facade-band maximum remain explicit. Coarse walls keep the original
single plane per edge and omit these near aperture details.

Validation: the new tests initially failed on the old eight-box limit, missing
equipment envelope and v2 flat-window grammar. `node --test tools/visual/*.test.mjs`
passes all 83 tests, including metric UV density, compressed GLB parity and native
canonical picking ranges. Three largest flat roof footprints in the existing
quarter semantics were assembled in memory only: 12,067 m² / 24 groups / 1,020 roof
fixture triangles; 9,357 m² / 23 groups / 988 fixture triangles; 7,284 m² / no equipment
because its source height is below 6 m. Corresponding total near/coarse triangle
counts were 24,068/1,108, 28,733/1,123 and 9,624/450. These are bounded geometry checks,
not a full-city cost estimate or visual acceptance. No pack was rebuilt here.
