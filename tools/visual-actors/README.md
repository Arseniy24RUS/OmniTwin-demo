# Civilian actor pack v1

Rebuild with `node tools/visual-actors/bake.mjs` from the demo repository. Download caches live in `.cache/game-actor-sources-v1` (not runtime data). Only the authored **Idle** and **Walk** clips are imported; no weapon, combat or fantasy geometry is selected.

- Quaternius Ultimate Modular Men: Casual_2 and Suit.
- Quaternius Ultimate Modular Women: Casual and Worker.
- Kenney Car Kit: sedan, SUV and van.

All seven templates are CC0. The manifest records official source URLs, input SHA-256 values, derived binary SHA-256 and copies of the author-provided license texts. People use a uniform presentation height of 1.8 m. Vehicles have a length of 4.5 m and independently normalized width/height: sedan 1.85/1.6 m, SUV 1.95/1.8 m, van 2/2 m. This removes oversized toy proportions that exceeded the displayed lane width. These are explicitly visual synthesis, never observed measurements. Geometry, baked normals and click picking use the same normalized model. Binary filenames include their content hash; the manifest switches atomically after all outputs exist, retaining previous binaries for rollback.

Node uses the existing Three GLTFLoader and AnimationMixer **offline**, then exact-pose-safe welding and the Three-bundled MIT meshoptimizer simplify each template to about 1400 person / 1000 vehicle triangles. Each vertex's entire animated trajectory must agree before welding. All 24 poses (8 idle + 16 walk) preserve shared topology. Positions and recomputed normals are stored as float vertex-animation textures; author material colors and Kenney's palette are baked to linear vertex RGB. Runtime interpolation needs two texture reads per attribute and one scalar presentation clock, not a skeleton per person.

Runtime click ray tests use the same baked poses, frame wrapping, heading and previous/next interpolation. Shared depth occlusion must compare the returned hit with the static-city hit in the owning layer. Billboards use the already-shipped shared actor atlas while near templates load; a model that did not load must not suppress an existing representation. The game layer owns the atomic readiness transition.

Visual QA is a separate gate: opening real browser PNGs is required before publication. Baking and numerical tests alone do not certify source-facing direction, color, foot contact, model appearance or FPS.
