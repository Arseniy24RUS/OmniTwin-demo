# Graphics release review — 2026-09-09

## Current owner instruction: publish this version with deferred bugs

The owner subsequently requested immediate publication of the current version,
with remaining individual bugs deferred. This supersedes the historical hold
below, without asserting complete artistic acceptance or completed deployment.
Runtime is frozen. The current exact-user replay and the roof comparison are
recorded in [combined02 evidence](../evidence/moving-combined02-evidence-20260909.json)
and [roof v3 evidence](../evidence/roof-normal-filter-v3-evidence-20260909.json).
Known source-surface budget fallbacks, input pacing and material-assignment bugs
remain in [the deferred list](graphics-current-known-limitations-20260909.md).

## Historical rejection during actual camera movement

The owner subsequently reported approximately 5 FPS while panning, slow
sequential facade appearance and uniform building materials. Publication is
held. The stationary-camera review below is historical and is not current
acceptance. Moving-camera CPU traces reproduced large traffic-constraint and
surface-reconstruction costs. The recovery plan is recorded at the top of
`../../IMPLEMENTATION_PLAN.md`; no Pages push has been made for local commit
08da267. New movement and visual evidence is required before release.

## Earlier local review

The integration is accepted for publication of this graphics revision with the
content limitations below. This is a qualitative review of the actual rendered
application, not a claim of measured visual equivalence to SimCity 2013.

The review opened the user close view, the large courtyard and the Miass
waterfront after the final palette and glazing changes. The seven-district
desktop/mobile ground review and full camera/fault sweep supply the wider
coverage. Building volumes and details retain their canonical owners through
zoom, source replacement and faults; people and cars are visible where the
source provides movement; the close aggregate strokes are absent. Water is
continuous, metric roof materials no longer produce large repeated stamps,
windows no longer form a glaring bright checkerboard, and the source ground,
trees, curbs, contact lighting and shadows form a coherent scene.

The exact-source footprint and height constraints are retained. Long panel
facades still have regular window grids, and large flat roofs have sparse
authored fixtures. These are visible limits of the current architectural
content, explicitly retained in the independent artistic review. A separate
read-only roof-grain experiment did not materially improve the large-slab
appearance and was rejected; no extra pattern was added solely to fill space.
Future richer building-specific art should keep the same source identity and
resource contracts instead of disguising missing surveyed details as facts.

The previous independent artistic reports remain intact, including their
stricter assessment that the scene does not yet equal SimCity. The publication
decision accepts the implemented revision and its concrete visual improvements;
it does not erase those limitations or convert technical tests into art proof.

Evidence:

- `facade-finish-art-evidence-20260909.json`: final desktop/mobile control frames,
  quiet glazing and zero paused frames.
- `facade-glazing-evidence-20260909.json`: canonical palette and day/night checks.
- `landuse-ground-evidence-20260909.json`: seven districts, exact masks and shadows.
- `roof-material-v2-evidence-20260909.json`: actual MET roof stamp diagnosis/fix.
- `city-graphics-final-evidence-20260909.json`: all 300 zoom samples, seven
  districts and five fault scenarios completed without detected ownership holes.
- `../evidence/junction-cold-rendered-opposing-pass-20260909.json`: independent
  all-actor sampled traffic-body validation and its scope limits.

No public deployment is asserted by this local review. Immutable upload,
public byte/CORS verification, backend compatibility, selective release and
the final public-page check are subsequent required steps.
