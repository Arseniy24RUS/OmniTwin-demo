# OmniTwin Demo — implementation contract

## Courtyard graphics overhaul — owner approved 2026-09-09

### Current release instruction — 2026-09-09

The owner explicitly requested publishing the current working version to GitHub
and GitHub Pages now, deferring remaining individual bugs. This supersedes the
publication hold below; it does not constitute complete artistic acceptance.
Freeze runtime changes, validate the production build, publish the current
immutable 13f118 catalog and matching activation, preserve the previous release
for rollback, then verify the deployed page. Keep population/chat pins unchanged
and do not repeat the two already completed paid chat checks. Record remaining
surface-budget fallbacks and deferred extended regressions for the next pass.
The current moving-camera replay removes the earlier 0.6–1 s frame stalls;
its detailed qualifications remain in the evidence. For this large upload,
allow an explicit bounded leaf concurrency of eight (default two); manifests
remain sequential after verified leaves. Test the bound, ordering and rejection
of invalid concurrency before uploading. No new application dependencies.

Current runtime committed and pushed as `5a71f9c`; Actions run 34378283448
completed successfully. Clean validation: 884 web tests and 189 tool tests
passed; 17 bulk-asset tests were skipped in the isolated build. The new visual
release `7ee3bd08c9973dd94ce727a6e3b148513e4dd125f2c82531541cf0b34971c83e`
uploaded 19,510 objects (8,369,746,051 bytes); all remote metadata and 44
anonymous body/CORS samples passed. The next small activation commit switches
the visual pin and clean-URL default to V2. This requested publication is now
complete: activation commit `4c62a5a`, successful Pages run 34378878812, and
the actual public smoke passed all 24 checks with no browser errors. Public
3D buildings, people, cars, both Workers, play/pause and canonical building
selection were verified. The remaining graphics work is explicitly deferred
to the next iteration, rather than declared artistically complete.

### Reopened: actual camera movement and visual consistency — 2026-09-09

The owner rejected the current local experience: approximately 5 FPS while
panning, sequential facade appearance and uniform building materials. Publication
is held. Commit 08da267 is local only; no Pages push was performed. Earlier
stationary-camera throughput and root artistic acceptance are insufficient for
this gate and are superseded by this rejection. Existing cloud assets and the
compatible chat revision remain unchanged.

Reproduce the current z15.703/pitch55.5/bearing109.565 camera in continuous drag,
including the actual narrow 494 CSS-pixel canvas and high-DPI display. Capture
frame-time tails and CPU stacks during movement, cold entry and revisiting tiles.
The initial profile identifies intersection constraint work and synchronous
surface reconstruction, not GPU rasterization alone. Work packages: preserve
traffic policies while eliminating repeated constraint work; retain surfaces
during gestures and rebuild only relevant data; budget LOD by useful screen
detail; make base/detail architectural materials consistent and varied; verify
physical display resolution. Each fix needs a reproducing test or trace, followed
by the same moving-camera workload and actual image inspection. No publication
until these gates pass. Canonical identities, turn/queue/signal safety, profile
links and pause behavior remain required.


The dense rejected-camera replay (958 actors / 90 paths) reduced the original
solver p95 from 198.60 to 75.62 ms with identical positions, visibility, signals
and diagnostics. That still exceeds a render-frame budget. The complete retained
traffic/bridge/footprint calculation now lives in one persistent Worker, with a
bounded FIFO protocol, coalesced source deltas and no main-thread solver fallback.
Five touching .25-second windows retain canonical membership and the matching
signal state. Actual entry/turn fixtures exposed up to .8 m seams with overlapping
.2/.25 windows; touching windows remove those witnessed seams. The shared actor
clock holds at missing coverage, then recovers ordinary latency with an explicit
maximum 1.1 presentation pacing multiplier. It never extrapolates through a
crossing. World/population clocks are unchanged. Sustained overload, especially
at accelerated time, is reported as visual lag. A paused source update retains
the current participants until playback resumes, with an explicit UI notice;
the worker never rewinds its retained queues to refresh a paused viewport.

The runtime-only actual narrow/high-DPI camera diagnostic improved warm panning
to 112.50 MapLibre render events/s (p95 10.7 ms), but cold zoom still contained
a 647 ms frame. It is explicitly not an acceptance pass. The subsequent CPU
profile identified first-use colour/depth shader queries and repeated provider
movement decoding. Tile replacement now waits for colour, scratch-target and
PCF depth programs, with two pending preparations, cancellation and retained
ownership. Actual WebGL startup and context restoration passed; combined moving
camera performance is still pending. Provider caches retain exact decoded and
schedule results under explicit bounds; source-output parity is required.
Evidence: `docs/evidence/moving-runtime-diagnostic-20260909.json` and
`docs/evidence/renderer-worker-motion-20260909.json`.

The new full-city compiler preserves 82,490 canonical buildings and source
geometry fields, while reducing delivered geometry from 13.376 to 7.889 GB.
Grouped apartment/stairwell bays, shop glazing, roof equipment and cheaper
window frames replace the previous repetitive detailing. Catalog
13f118a1b6e0af680e836979be0bef0f6a69bf6615a3ea3761b3e660bcc2b221 declares the
audited 2 m coarse detail error directly, with a separate immutable metadata
transformation and complete hash-verified closure. Three actual static controls
were inspected; their cold-paused empty actor inventory is a documented defect,
not an actor/FPS acceptance result. Empty and partial cold-paused inventories
now refresh at the same frozen instant without advancing retained queues.
Evidence: `docs/evidence/facade-full-catalog-20260909.json`.

Seven-CSS-pixel pedestrians now receive their existing baked model, with the
distant glow fading over 4–8 CSS pixels and unchanged instance caps. A projected
camera/picking regression failed first and passes after the change. Actual
close-view appearance and its frame cost remain part of the combined run.
A temporary segmented tree-crown candidate was visually rejected and was not
integrated. Earlier published immutable resources remain intact.

### Historical integration acceptance before owner rejection — 2026-09-09

The full fine-detail catalog is active locally. Two additional cache races now
have failing-first tests: a native-bank commit rebases the next candidate within
the staging limit, and a newly parsed tile cannot be retired before an ordinary
frontier traversal reviews it. Actual MET buildings 6939524390 and 6939524400
retain detailed meshes with zero denied/pending tiles. The settled camera drew
zero frames over 2.21 seconds. Evidence: `docs/qa/cache-met-postfix-20260909.json`.
The final sweep completed all 300 zoom samples, seven districts and five fault
scenarios: 336 samples, 2,081 assertions, zero reported failures. Evidence:
`docs/qa/city-graphics-final-evidence-20260909.json`. Its optional signal-prop
collector used an incorrect DOM name; the separate final hardware/control run
verified the actual `data-game-signals` diagnostics and visible props.

Exact-source courtyard paving, wall-contact lighting and masked landuse ground
are implemented. Roof filtering removes the repeating metallic stamp; organic
tree crowns replace paired lobes and regular synthetic rows. Neutral canonical
facade finishes and daylight-aware glazing reduce identical pale walls and
bright window cards. Actual desktop/mobile image reviews and day/night checks
are recorded under docs/qa. Window cadence and large plain roof areas remain
explicit artistic limitations. The qualitative release review accepts this
revision with those limits; it does not claim measured SimCity equivalence or
overrule the stricter independent art reports. See
`docs/qa/graphics-release-review-20260909.md`.
Immutable publication and public audits passed: 19,543 visual objects and 481
movement objects, complete metadata inventory plus anonymous SHA/CORS samples.
Firebase revision chatapi-00002-zup is ACTIVE with unchanged runtime policy and
secret references. Both normal legacy/V2 chat compatibility calls passed. The CLI
returned exit 1 after updating the function; source inspection and repository
metadata support the missing cleanup-policy post-deployment branch. No cleanup,
IAM or billing policy was changed. Pages publication is the remaining stage.

Independent GPU-body testing passes the original courtyard for 57.5 seconds,
503 samples and 142 canonical actors, including rotated vehicle envelopes and
all baked pedestrian poses. The wider cold-playing camera now also passes:
356 samples across 74.949 seconds, 650,519 car/car and 7,063,008 car/pedestrian
body checks, no detected overlap, minimum same-lane headway 8 m, no source
reanchors or controller overflow, and zero final paused frames. Shared opposing
route sections reserve connected bends together; duplicate junction IDs no
longer hide signal props. The fresh user tab showed 46 heads and three draws.
Evidence: docs/evidence/junction-cold-rendered-opposing-pass-20260909.json.
The wide view uses sprites and nominal body envelopes; sampled tests do not
prove whole-city continuous-time collision freedom. The final hardware run on
Chrome/RTX 4090 measured 106.25–106.98 actual MapLibre render events per second
in three control scenes, and zero frames in six settled 2.2-second pause windows.
All four person/car/passenger/building interactions passed. Recordings were
separate from FPS measurement. These are device-specific results with declared
background load, not monitor presentation rate or a mobile FPS guarantee.
Evidence: `docs/evidence/final-hardware-controls-20260909.json`.

Final clean exact-lock validation: 774 web tests and 177 Node contract tests pass;
the excluded bulk-asset cases were checked separately against the complete
local source. Build/typecheck and public-shell validation pass (125 files,
44,285,063 bytes before activation JSON). The six pre-existing staged Yandex
files and local handoff document are excluded from this release. DEV same-origin
loopback keeps local sources with published SHA pins and explicit preview status;
three actual browser cases preserve canonical profiles with zero cloud requests.
Evidence: `docs/evidence/local-public-activation-20260909.json`.

Remaining release work: publish the full frontend tuple with legacy default;
inspect the explicit public
V2 page, then switch only the default dataset. Keep prior Pages commit
21ee9a4543f7ee1acc4004fe5c11aea043490724 as the rollback baseline. The older
checkpoints below record intermediate work and are superseded by this status.

### Owner addition: coordinated vehicle and pedestrian signals — 2026-09-09

Introduce shared intersection right-of-way for intersecting at-grade source
routes. Vehicles wait before the conflict area with their existing lane headway;
pedestrians cross in a separate phase. Occupants must clear before a conflicting
phase is released. Signal timing and decorative signal props are explicitly
visual synthesis, not observed municipal signal data. Keep source routes,
canonical identity, passenger/profile links and source presence semantics.
Use the existing simulation clock and retained controller through refreshes;
pause and seek remain explicit. First reproduce crossing vehicle/vehicle and
vehicle/pedestrian conflicts, then verify red-light stops, safe drain, queues,
phase changes and actual moving-browser frames. The local gate passed with the
body/phase evidence above; public rendering remains part of release acceptance.

Implemented locally: retained shared conflict zones, separate vehicle axes and
pedestrian phase, clearance that waits for incumbents, stop caps before lane
headway, and controller-driven roadside signals. Provider corridor provenance
now supplies exact constituent road IDs, widths and grade hints. No phase clock
is independent of the presentation clock. All 72 focused controller/bridge tests
pass, including offset-body conflicts, fresh pedestrian admission, a green phase
ending inside an interpolation window and overlapping nearby junctions. The
first actual source trace checked 181,687 pairs without distance violations;
independent interpolated body geometry and moving visual acceptance remain open.

### Owner addition: smooth vehicle turning — 2026-09-09

Replace instantaneous vehicle heading changes with continuous presentation
rotation at route corners and direction changes. Preserve source positions,
lane spacing, canonical IDs, passengers and picking. Verify shortest-angle
rotation across 360 degrees, pause, speed changes, seeks and provider refreshes,
then inspect a moving real-car recording. Orientation implementation passed 66
focused tests and typecheck. Actual trace: 137 canonical cars, 364 source corners,
11 near-180-degree reversals, peak 119.989 degrees/s, zero rate violations.
A pause during an active turn kept time, yaw and position unchanged; seek reset
the transition. Evidence: `docs/evidence/vehicle-heading-20260909.json`.
That recording used software WebGL and does not establish frame-rate quality;
the combined signals/turning release still needs its hardware-browser video.

### Owner addition: lane speed and vehicle spacing — 2026-09-09

Cars currently overlap because independently sampled routes have different speeds.
Implement a retained presentation queue for each source lane/direction: common
lane speed, a conservative vehicle body envelope and a visible following gap.
Keep canonical IDs, source routes, passengers and semantic profiles; mark the
queue/spacing policy as visual synthesis. Preserve continuity through provider
refresh, pause/speed changes and explicit seeks. Acceptance requires a moving
same-lane video plus position/headway checks, including a faster rear car, an
entering car, a route junction and a five-second provider refresh. This addition
supersedes the earlier statement that visual overlaps are accepted.

Implemented locally: retained queues with an 8m centre headway, common source
lane speed, verified-width right-hand offsets, and directional yielding on narrow
roads. Actual 24.39s video/probes: 8,337 same-lane pairs, zero spacing/speed
violations and zero source reanchors through five source refreshes. The actual
V2 ping-pong route also passed seven actual-browser checks: retained identity,
continuous endpoint turnaround and no source reanchor. All source-present cars
in that scene joined the queue. CC0 vehicles were rebaked to widths
1.85–2m rather than the prior 2.45–2.65m; template and picking geometry agree.
Evidence: `docs/qa/traffic-presentation-evidence-2026-09-09.json`.
Turnaround evidence: `docs/qa/pingpong-traffic-evidence-2026-09-09.json`.

Current integration: source-polygon water/bridge decks, metric land cover,
source-clearance vegetation, and bounded source-dirty flushes on the existing
render scheduler while time runs. Courtyard furniture is owned by compiled
canonical building tiles at every LOD; there is no second runtime furnishing
layer. Building art v3 was compiled for all 82,490 source buildings in seven
districts; all 1,331 jobs resumed without recompilation and reproduced catalog
SHA `fac040ca18c22b0a8eb7d6b7f761eb3972aecbd5b40a71e7189ecbb4f116b59f`.
This proves deterministic compilation, not visual acceptance. The previous
visual publication plan is historical and must not be used for these new bytes.

Fine-detail generation 4 now partitions each source job into 6×6 ownership cells
with a 240,000-vertex target and bounded adaptive splitting. All 82,490 canonical
buildings are conserved; resume reverified all 1,331 jobs, compiled zero jobs and
reproduced catalog SHA
`bca4ff81f5a4c1a8c3517f0b1faeceddd6042cf20d811c70661993ecec72a819`.
Offline verified publication release
`96716050fe80bd534b3f81bb80e27e651b486b4f12b6b9270ac9487127149c3a`
contains 19,543 objects / 13,784,759,826 bytes, root SHA
`d1f25e4328caf10ddf7e3e6f8e2734b7cfc63b0ac7a28b0eb410af3fc53cf9cc`.
This is a prepared local plan; no visual upload or public activation has occurred.

The earlier full-v3 desktop/mobile review exposed these art blockers: large detail
groups consume the geometry budget and leave important foreground buildings
native, industrial roof patterns alias, and courtyard ground lacks convincing
detail. Fine-detail generation 4, roof filtering and courtyard paving address
those findings. Revisit the three actual control scenes and all seven districts
before publication; checksums and a successful build do not prove visual quality.

The transient denial is reproduced by a 170-unit old frontier, a rejected
65-unit foreground tile, then a 51-unit replacement. Admission now retries the
foreground only when released capacity can fit its known size; corrupt and
oversized resources remain denied. Same-camera regression and cache/lifecycle
tests pass. Close compiler groups now use a 6x6 source-owner grid (about120m)
and 240,000-vertex target instead of 2x2/1,700,000. Canonical buildings stay
whole; per-cell assets remain bounded to 63 detail leaves. A failing distributed
source fixture now yields four independent leaves with identical ID coverage.
The resulting generation is compiled; final actual-frame review is in progress.

Read-only public inventory verification passed for the existing source pack:
38,920 exact metadata objects plus 10 public byte/CORS samples. Nine public
profile contexts equal local contexts. Evidence is in `docs/evidence/`.
Firebase V2 pins are prepared locally (activation SHA
35319bb7b4068e6b7e8c281f6eb45ec70ca2be80c83c516460160f226938cbf9),
but no cloud function deployment, visual/movement upload or Pages activation has
been performed by this campaign. Finish art/motion/fault/mobile gates first.

### Locally verified membership regression — vehicles every ~6 seconds

Owner reports that the currently visible local version with new textures again
teleports cars approximately every six seconds. Reproduction camera:
longitude61.40324326242887, latitude55.166511972647186, zoom16.543982104833812,
pitch46.49661799282392, bearing-172.97699800600026; graphics=tiled_game,
dataset=omnitwin-fictional-city-v2, playing at1x around presentation minute750.27.
Reproduced cause: every five-second presence anchor reran glyph overlap suppression,
removing active canonical cars and later returning them farther along the same
source route. Fail-first component and declutter tests cover a new candidate
replacing an existing car and two retained cars converging at a later anchor.
DemoCity now commits the previous canonical ID preference. In tiled_game only,
still-active retained members survive later overlap; overlapping new entrants
remain suppressed, selected newcomers retain priority, and source absence, explicit
seeks and semantic/provider changes are respected. No stale actor positions,
invented routes, changed speeds or scientific semantics are introduced.

Local verification: two 90-second real-browser runs, 900 attribute probes each;
opaque removals 691→67 and opaque reappearances 527→31. Source replay classifies
all remaining removals: 63 viewport exits and four completed trips; active
inside-viewport opaque removals and same-ID jumps are zero. 69 focused tests,
typecheck and diff-check pass. Actual PNGs were opened; the buffer/Float32 probe
is not a post-fix pixel-motion video, and rAF timings are not map/GPU throughput.
The existing user IAB ran older code and needs a separate post-refresh acceptance.
This membership checkpoint alone allowed overlaps; the later lane-spacing
addition above supersedes that limitation. It is not traffic collision simulation.
Portable evidence: docs/evidence/vehicle-retention-20260909.json. This local
membership fix does not close full graphics, citywide, mobile or public gates.

Deliver a stable, realistically stylized city-to-courtyard view, followed by a
verified public Pages release. Work only in this demo checkout; preserve dirty
work and the six staged Yandex files. Scientific runtime, observed data, secrets,
OpenRouter configuration and billing remain unchanged.

1. Root: replace all-or-nothing quarter visibility with committed canonical
   coarse/detail ownership, pin drawable parent/frontier through refinement,
   independent actor visibility, near-zoom overview fade and actual frame QA.
2. Canonical source owner: two retained source banks with worker-ready staging,
   stale/error protection and atomic bank/frontier commit; exact IDs only.
3. Material owner: metric repeating surfaces, normal/roughness material kit,
   improved eight-family facade/roof grammar, bounded detail and source provenance.
4. Water owner: real water polygon mesh, periodic world-space normals, consistent
   shorelines, one retained draw path, supplied-clock pause and low-tier fallback.
5. Root: integrate coherent lighting/antialiasing, resumable visual tile catalog,
   source/hash/per-tile owner validation, bounded memory and seven-district coverage.
6. Acceptance: user camera (61.4033593,55.1666411), central quarter, four boundaries,
   river; zoom14–20 at0.25 steps and continuous wheel/rotation; desktop/mobile,
   cold/warm/error/eviction; actual person/car/passenger/building picks; >=30FPS
   target and paused <=2frames/2s on the measured device. Open actual PNGs/video.
7. Publish immutable visual/data assets only after visual acceptance, verify
   compatible population/chat, update Pages and verify the real public URL with
   rollback preserved. Technical tests alone do not close visual acceptance.

Primary frontend owner remains MapLibre camera + Three in one WebGL2 canvas;
no independent animation loop. Camera stops at courtyard, not street walking.
New source-bank, material and water contracts are tested before integration.
Current browser evidence confirms whole-viewport quarter gating, stretched roofs,
plain fallback materials and full-opacity water-gloss; intermediate-zoom blank
frames remain a reproduction target rather than a claimed diagnosed root cause.

## Handoff continuation — 2026-09-09

Preserve the existing dirty checkout and six staged Yandex files. Current work is
the clock/decoded-cache checkpoint: reproduce pause/resume and speed changes
followed by a delayed parent sample; distinguish explicit seeks, including small
backward slider changes; run single-worker frontend tests/typecheck/build; then
repeat real headed 1×/16× motion and warm CDP profiling, opening PNG/video evidence.
After that, continue the existing visual and compatible cloud rollout gates below.
No public acceptance is inferred from this local motion checkpoint.

Verified: clock regression and explicit seeks; graphics-context provider reload
after a screenshot exposed old native routes in game mode; non-overlapping status
messages; warm 16× CDP; real 1×/16× motion and controls; camera/reload/mobile and
native person/vehicle/building clicks. Evidence and remaining release gates:
`docs/TILED_GAME_CHECKPOINT_RU.md`, continuation dated 2026-09-09.

### Next visual iteration: building appearance

Opened quarter PNGs show overly uniform facade colours and empty roofs. Add
deterministic illustrative facade tint variants and bounded flat-roof fixtures
inside source rings with a conservative setback from outer edges and holes.
Keep source family/classification, height, footprint, IDs and population intact;
record the added appearance as visual_synthesis. Test geometry bounds and LOD
consistency first, compile one new quarter to a separate cache directory, then
inspect it in the real browser before considering it an accepted visual update.

Completed locally: six facade tints and 487 rooftop fixtures; source geometry and
IDs preserved, 47 compiler/actor tests pass. Independent output has the identical
manifest hash. Four real desktop/mobile PNGs opened; brief movement p95 16.1 ms,
zero paused frames, diagnostic under background load. Courtyard environment and
citywide art remain unaccepted. See the appearance continuation in the checkpoint.

### Streaming integrity checkpoint

Before decode, verify each GLB/texture against the manifest byte count and SHA-256.
Carry the validated descriptors into the existing exact-URL policy; reject partial
inventories, corrupt/truncated/oversized streams and redirects, cancel failed reads.
Keep the already verified root in memory and preserve native fallback on failure.
Start with corruption/abort tests, then real quarter loading and motion/pause QA.

Verified locally: six failing cases now pass; 485 frontend tests, typecheck and
production build pass. Four final real PNGs opened, no page/HTTP errors; short
diagnostic p95 15.4 ms, paused frames 0. The manifest still needs an independent
immutable publication pin; bundled actor assets are outside this visual-pack gate.

## Motion continuity and mode-aware roads — 2026-09-08 follow-up

Flow under test: loaded quarter → 30 seconds of1×/16× motion with selected profile → same-ID trajectory across refresh → source footways versus vehicle road → dead-end versus connected street → pause/reload.

Owner-reported symptoms: approximately6s pauses/teleports, pedestrians on carriageways and excessive dead-end traffic. Reproduce movement continuity separately from rendered FPS; a healthy frame counter does not prove continuous coordinates. Main owns actual Playwright/CDP diagnosis, clock anchoring, DemoCity geometry retention and integration. Provider owner handles bounded movement preparation; actors owner handles retained columns/interpolation; graph owner handles source-mode eligibility/connectivity. No changes to population totals, observed statistics, scientific runtime, OpenRouter or public deployment before visual acceptance. Browser skill absent: use existing real headed Playwright, one worker, artifacts outside source.

1. Record a baseline at the same camera; characterize clock/reconciliation failures before edits.
2. Keep render-time clock monotonic through unrelated React renders; retain immutable geometry/road work and actor buffers across time updates.
3. Prioritize actual pedestrian ways and explicit sidewalk data; do not equate road pedestrian access with a separate sidewalk. Separate vehicle permissions and constrain dead-end/service traffic using source connectivity, with synthetic weighting explicitly labelled.
4. Re-run targeted tests, build, short actual browser motion/picking/pause and open final PNGs. Keep unproved symptoms and remaining source coverage limits explicit.

## Tiled game renderer — owner approved 2026-09-08

This campaign supersedes native-only city rendering and the 3–5px firefly cutoff below. Scope is this demo only; the national model and observed statistics are untouched. Approved camera scale is city → district → courtyard, not street-level. Preserve the existing RUDN shell, analytics, profiles, chat and provenance.

1. First technical/visual gate: one MapLibre6.4.1 canvas with Three0.185.1 custom3d layer, correct local-meter camera/depth/color state, source-backed quarter mesh tiles and ready-before-replace coverage. No old diorama, giant plane/sphere, additional RAF or duplicated city actors in Deck.
2. Source geometry becomes a reusable eight-family facade/roof/road kit. New GLB/3DTiles manifests preserve canonical IDs and provenance; shared4×4 material atlas, authored actor assets and licensed reusable art replace tiny facade swatches. Initial quarter is centered on61.39466,55.1654, bounded1.2km square; whole-city compilation follows actual screenshot acceptance.
3. Living readiness retains potential route entrants and last-good generations; aggregate flows remain until individual data is ready. Glow→body transition is8–14CSSpx with metric bodies and stable IDs. All tiers use bounded instances, not one GPU object per resident.
4. Public V2 activation remains gated on verified cloud assets/backend/profile/occupancy consistency and real rendered acceptance. The earlier upload has completed but its receipt still says publicReady:false; no successful public activation is inferred. Legacy8246 links remain labelled and reproducible.
5. One-worker real Playwright: projection/depth, native clicks, right-drag/pan/zoom, quarter-to-neighbor, time16×, day/evening, desktop/mobilePNG. Open every accepted image; frame counts do not prove pixel visibility.30FPS floor/paused≤2framesper2s; background model makes FPS diagnostic only.

Ownership: root existingSceneRuntime/WorldScene/DemoCity integration, policy/contracts/config/tests, generatedmaterialasset and visualQA; Hubble newrenderer/game/TiledGameLayer+camera; Singer tools/visual sourcecompiler; Linnaeus CityDemoProviderV2 readiness; game_actors newGameActors+licensedmodelpipeline. All existing/unrelated edits remain preserved, particularly stagedYandex files. No install through sharedrootnode_modulesjunction.

### Local quarter checkpoint — implemented, not a public release

The opt-in `graphics=tiled_game` runtime, source-backed quarter compiler, real instanced CC0 actors, readiness bridge and actual headed Playwright path are implemented. Current geometry is 382 buildings / 808 roads / 1000 source-area-derived trees, root+four child GLBs. No all-city visual pack or public V2 activation is claimed. Technical PNGs show real people/cars, roofs, trees and shadows without camera-material loss; courtyard art remains too empty/repetitive for the requested SimCity-like release gate. Detailed commands, provenance, diagnostics, limitations and next gates: `docs/TILED_GAME_CHECKPOINT_RU.md`. Do not skip this failed visual/public gate merely because unit tests or one desktop FPS window pass.

## City-scale repair campaign — owner approved 2026-09-07

Current implementation sequence (supersedes the small-person-fixture default, not observed statistics):

1. **Published and visually verified — checkpoint 1 only** — atomic materials, governor recovery, metre-scale bodies, surface-aligned cars, and owner-requested far firefly LOD. Four real desktop/mobile Playwright tests pass both on the production preview and public GitHub Pages release `ae36599`; all 32 final PNGs from each run were opened. Selection refresh no longer reopens the mobile sheet. After native tile/idle stabilization both paused checks recorded zero new frames in 2.2 seconds. This does not close city-scale density or controlled performance gates.
2. **Built locally; not visually accepted for activation** — immutable seven-district geography/assignment pack and coherent 1,177,058-person fictional baseline. All seven real-browser views load, but some street views still look sparse and general-plan flows cluster too narrowly. Observed 2024 sex/age marginals seed an explicitly fictional 2026 reference, never a 2026 observation. Legacy 8,246 remains the public default.
3. **Implemented and tested locally; cloud activation pending** — indexed async profiles/occupancy/scenarios, shared canonical Firebase-compatible profile resolver and immutable-asset publisher. No V2 storage upload or backend deployment has occurred in this campaign. Public activation requires compatible backend, uploaded verified assets, and the remaining visual gates. No OpenRouter key or spending-cap changes.

The current source/artifact lineage and limits are recorded in `docs/CITY_V2_DATA_RU.md`; screenshot acceptance and remaining release work are in `docs/CITY_REPAIR_CHECKPOINT_RU.md`.

### Scene contract and specialist ownership

### Continued city-scale release work — 2026-09-08

Owner asked to continue until the GitHub demo is repaired. Published checkpoint 1 is preserved while checkpoint 2/3 is completed locally. The tested flow is: source-backed seven-district viewport → distributed motion → native person/car/building click → consistent paginated presence/profile → analytics/scenario → reload. Browser plugin is unavailable; reuse the repository's headed Playwright with one worker, real tiles/API and opened PNGs.

- Living owner: replace center-biased aggregate-flow sampling with bounded viewport stratification, preserve source routes and retained GPU data.
- Population/provider owner: repair prepared-profile cache precedence, investigate and fix activity-aware cell candidates without changing population/scenario semantics.
- Main: building inspector distinguishes assignments from current visitors; full roster total, pagination/time transitions, native click and desktop/mobile screenshot QA.
- Read-only release reviewer: verify Firebase manifest/backend/default activation compatibility and safeguards before any cloud mutation. No new key limits or scientific work.
- Public activation sequence remains verified assets → compatible server → real V2 profile and visual gates → atomic runtime config → Pages verification. Do not publish a sparse/blank frame merely because the browser test passes.

- Artifact/job: inspect fictional people, movement and building presence in real Chelyabinsk geography; the separately sourced observed SVG analytics stays unchanged. Existing approved composition is retained, no new concept approval needed for these repairs.
- Primary owner: MapLibre camera/static vector tiles, one WebGL2 canvas. Deck interleaved retained actor buffers; Three disabled. Lon/lat source positions become local metre coordinates with surface Z; people height and car length use metres, UI/picking hit areas use CSS pixels.
- Material owner: one phase/quality/zoom/atlas/governor decision, atomic visibility plus fallback ranges. No overlapping plain/patterned primary extrusions. Ordinary camera motion does not erase materials.
- Visual mini-briefs: material engineer owns stable source-backed surfaces/lighting; actor engineer owns physically scaled sprites/depth/picking; geography engineer owns dated footprint/road/boundary coverage; population engineer owns deterministic entities/stocks/events; provider engineer owns shared presence, lazy pages and spatial coverage; main owns integration, mobile, real screenshot review and release.
- People/car caps high 1200/1800, mid 500/800, low 160/320; total logical population is not an instance count. Beyond individual LOD use explicitly aggregate flows, never fictitious individual identities.
- Owner addition: individually represented distant people use a soft cyan firefly impostor (8 CSS-pixel quad, about 5 visible pixels after alpha cutoff). Transition follows actual projected body height: full glow through 3 px, smooth blend to an ordinary unlit body at 5 px. Identity, world depth, physical near scale and native click picking are unchanged; no bloom or extra canvas.
- Clock: demographic year/scenario independent from local presentation time/weather. One scheduler, paused/off-route/hidden world stops animation; GPU interpolates bounded worker state. Preserve previous good geometry during failed/stale tile loads.
- Interaction states: loading → ready/partial → moving/paused; selection opens person/building/car, close restores summary; selected body does not enlarge. URL includes dataset/version context and camera; Back/reload deterministic.
- Sibling views: desktop 1920×1080, portrait 390×844, landscape 844×390; preserve map/summary/bottom sheet, 44px controls, tap/picking and list alternatives; no sensor/permission requirement.
- Readiness: correct actual/target camera, tiles and atlas ready, fresh telemetry, one canvas, no framework overlay/context loss; submitted instance counts are not pixel visibility evidence.
- QA: failing targeted tests first; one real Playwright worker (Browser plugin not available). Right-drag/wheel/pan before/during/after, depth and physical scale, seven districts, occupancy conservation/rosters, observed regression, Back/reload. Open every accepted PNG. Artifact output outside source, performance under running model classified contaminated_diagnostic.
- Safety: only this demo workspace changes; original scientific repositories/processes and existing unrelated staged Yandex work remain untouched. No installs through the root node_modules junction. Shared workers must not revert each other's edits. No deployment until relevant visual gate passes.

Public fictional demonstrator, independent of scientific RUSDEM/OmniTwin runtimes. Original repositories and running model processes are read-only and must remain untouched.

## Design lock

- Approved desktop and mobile concepts: city first, compact summary; header Living World / Agents / Scenarios / Analytics / About.
- Original RUDN PNG, author Sitkovskiy link. Navy #06131c, panels #0a1d28, cyan #09c8d8, warm amber #f4b24d, text #eef5f6, muted #91a8b5. Inter/system UI; 44px primary targets. No concept raster used as map.
- Separate demographic year/scenario/cohort and presentation clock/weather. Fictional provenance visible without technical debugging clutter.
- Large-screen city+right rail; mobile portrait city+bottom sheet; landscape compact rail. Selected person/building/car replaces summary.

## Work and ownership

1. Main: standalone monorepo scaffold, app shell, URL context, summary/agents/inspector, chat client, Pages workflow, integration and actual browser QA.
2. Data: versioned contracts, original tiny fixture preservation, deterministic complete fictional population and precomputed scenario ledger, static provider and invariants.
3. Analytics: reuse existing data semantics and SVG/export implementation, responsive analytical page and real numerical comparisons.
4. Renderer: reused MapLibre runtime, standalone policy injection, source-backed layout, retained actors, public asset paths, camera and selection.
5. Chat: private server handler, immutable profile verification, atomic quota adapter, signed sessions, deployment artifacts and tests.

## Validation

Unit/TS/build first; one headed Playwright worker with real app/API/tiles. World→analytics→scenario→agent→map/chat→Back/reload. Desktop1920×1080, portrait390×844, landscape844×390. Open actual PNG and approved reference side by side. Measurements under model load are contaminated diagnostics, never release performance claims. Keep artifacts and honest mismatch ledger as requested. No publication of raw scientific data or keys. Public deployment and hosted LLM readiness need verified account/configuration and end-to-end checks.

## Checkpoint outcome

Standalone implementation, clean-install/build gates, 82 frontend tests and seven real production-browser journeys completed. Detailed evidence and remaining public-host/LLM/performance gates: `docs/DEMO_STATUS_RU.md`. External hosting and live chat activation are not implicitly marked complete.

## Observed Chelyabinsk correction — 2026-09-07

Latest owner request supersedes the fictional-only default for city statistics. Preserve the legacy and fictional person/scenario datasets; show a separately verified public municipal reference by default. No national model files or processes are modified.

- Data: exact OKTMO 75701000, observed annual stocks and sex/age partitions from one PMO indicator vintage; corroborate public Chelyabstat releases. Manifest-bound SHA/bytes, source URLs and as-of dates; no local paths, personal records, or inferred missing values in published artifacts.
- World summary / analytics: real city history and population pyramid. Separate fictional character/scenario context from observed year in URL; weather/time never changes either dataset. No fictional microdata drill-through from observed bars. Unavailable subterritories remain no-data, not city totals redistributed.
- Visual inventory: SVG history (discrete stocks, explicit census-series break), mirrored five-year age bars (shared zero/scale; open-ended 70+ separate), exact accessible table and source-bearing CSV. Cyan male/history, muted violet female, amber fictional context. Mobile preserves as-of/source and essential values without hover.
- Ownership: main data/provider/context/integration; observed inventory and primary-source audit are read-only except small new evidence artifacts; analytics specialist owns observed components/export/chart QA; chat specialist owns Node handler compatibility only.
- Verification: failing data/navigation tests first, reconciliation and SHA gates; short single-worker real production desktop/mobile journeys, open PNG. Verify Pages serves application rather than repository README. Live chat requires private cloud configuration and quota smoke-tests; no exposed key is saved or reused.

## Firebase migration — 2026-09-07

Owner explicitly selected Firebase and authorized a dedicated project, usage-based deployment and server-only use of the previously supplied OpenRouter credential. The credential must never enter source, public assets, command-line arguments, repository history, logs or QA artifacts. The prior no-reuse preference above is superseded only by this explicit owner decision; secret handling remains mandatory.

1. Main: verify saved console login, create isolated OmniTwin Demo project, inspect billing availability; do not change or delete Yandex resources or any unrelated project.
2. Backend worker: framework-neutral HTTPS adapter and Firestore transactional quota adapter, with offline failure/concurrency/body-limit tests first. Preserve Yandex compatibility.
3. Main: Firebase Functions v2 package, Secret Manager bindings, zero minimum instances, bounded maximum instances/concurrency, private Firestore rules, expiry cleanup and deployment documentation. Keep frontend on Pages and maintain existing API contract.
4. Acceptance: profile/hash packaging checks, offline server tests, real cloud origin/session/quota/LLM checks, then enable public chat URL and one short real-browser chat journey. No secret-bearing screenshots or payload logs. Do not claim live readiness before actual checks pass.

Scientific sources and running national model remain untouched. Cloud/account authorization or unavailable billing is a real deployment blocker, not a reason to use client-side keys or bypass security. No automatic top-up or new subscription is enabled.

### Owner spending decision — 2026-09-07

Owner explicitly declined an OpenRouter key cap and stated the existing prepaid balance is $8 with automatic replenishment disabled. Do not create or change a key spending/reset limit; do not change auto-top-up. This supersedes the earlier $5 key-cap activation gate. Enable the dedicated public chat function, retain durable server request quotas, run a bounded real inference and idempotency smoke, then publish only the HTTPS runtime endpoint and verify the real Pages resident-chat flow. The stated balance/top-up setting is owner-reported, not independently verified account evidence; no universal cloud-spend cap is claimed.

## Public movement overlay preparation — 2026-09-09

- Preserve the exact source-mode-v2 manifest and all population/household/building assignments. Prepare a separate immutable publication prefix; add explicit runtime-config URL/bytes/SHA plus all three base source pins. Keep localhost preview backward-compatible and keep the legacy dataset isolated.
- Fail-first activation/closure checks captured, then implemented bounded source/codec/asset/gzip verification, decoded page/context closure, create-only transport reuse and independent deployment attestation. No source recompile or source-manifest mutation.
- Offline closure passed: 481 objects, 33,854,989 stored bytes, 112,011,796 verified raw+gzip bytes; release `a825cb2f215a04483ff7ba4932dde38c34763260177aa6da5ab9920263a4a019`. Exact manifest SHA remains `625391b37ea50add3c40c4ad715124e8fcf395cbd5610f55bc7f5a68b74a7245` (109,055 bytes).
- Combined publisher tests: 37 pass. Focused runtime activation/provider checks: 54 pass, including 18 source-vs-overlay profile, household and home/work/study comparisons; typecheck passed. Detailed procedure/limits: `tools/movement-release/README.md`.
- No auth/upload/runtime-config mutation was performed. Publisher keeps chat compatibility pending. Owner may separately attest `base_profiles_unchanged` only after backend V2 rollout/read-back/tests and exact three-pin verification. Public activation remains blocked on traffic spacing/common-speed work and browser/video QA; this does not mark overall graphics acceptance complete.
