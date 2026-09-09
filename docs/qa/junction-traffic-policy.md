# Visual traffic at source intersections

`LaneTraffic` and `JunctionTraffic` control presentation positions and roadside
signals. Their metadata classifies this policy as `visual_synthesis`. Source
actor IDs, routes, passengers, population, authored speeds and presence remain
unchanged. The signal timings are visual assumptions, not surveyed timings.

Cars retain an 8 m centre headway and use the minimum authored speed of their
current source lane. At a junction, the stop barrier applies before the follower
queue, so a red light propagates to following cars. Source pedestrians wait for
their own phase. Current occupants drain before conflicting approaches can enter.
An undisplaced vehicle centreline has one direction authority even when opposite
source geometry is encoded as separate forward-only edges. This applies before
lane metadata arrives; verified separated lanes can use their own directions.
New source entrants yield to existing occupants; an entrant with no safe source
position waits hidden until it can be admitted. Source absence immediately removes
the actor from the presentation inventory.

`OpposingLaneReservations` also handles distinct full source routes that share
only part of an undisplaced centreline. Exact supporting-line overlaps define
the reserved sections. Consecutive sections merge only where their occupied
arclength intervals overlap on an actual shared source path. Direction parity
aligns the independently oriented straight sections through bends. An incumbent
can therefore drain a bent narrow corridor before the opposite direction enters.
This restricts existing display positions without adding a lane or claiming a
surveyed grade. Self-reversing orientation conflicts explicitly use one new actor
at a time while existing occupants drain (`exclusiveSections`).

The 30 second presentation cycle contains 8 seconds for one vehicle axis, 2
seconds of clearance, 8 seconds for the other vehicle axis, 2 seconds of
clearance, 8 seconds for pedestrians and 2 seconds of clearance. Occupancy can
extend the wait beyond a scheduled phase. Phase and source refreshes use the
existing presentation clock. Pause preserves positions, and an explicit seek or
dataset change resets the retained controller. Prediction holds a stop until the
current sample permits entry; it also prevents entry after green ends within an
interpolation window. A hidden entrant stays hidden throughout a predicted window
and can appear at the next current sample. This prevents a departing car and an
arriving pedestrian from crossfading through the same occupied endpoint.

Conflicts come from displayed source segments, including lane offsets, exact
intersections and shared vertices. Body sweeps additionally catch offset segment
endpoints where 4.5 × 2 m cars or 0.35 m pedestrian envelopes can overlap even
though their centreline segments do not intersect. Adjacent pieces of one source
polyline do not become a junction just because the polyline bends. Stop and
occupancy intervals that overlap on an actual shared source path are merged
transitively to prevent circular reservations between adjacent junctions. Shared
longitudinal car/pedestrian corridors have separate reservations, so a long shared
route does not combine every transverse junction into one area. Physical incoming
lines and directions identify approaches; source route variants remain separate
routes but do not consume extra approach slots or create duplicate signal heads.

Near source bends, the vehicle envelope encloses every body angle while the
renderer completes its smooth turn. Its bounded interval follows the production
heading duration, maximum presentation lane speed and 0.25 second interpolation
horizon. It does not widen entire straight roads. Whole-route and shared-segment
following constraints converge monotonically, up to 64 passes, before publishing
the next positions. Joint lane/junction admission has the same bounded pass count;
both overflow counters are explicit.

Raw road metadata joins through exact source corridor constituent IDs. Verified
grade-separated crossings are excluded. Cars and walkers on the same verified
bridge corridor still share a longitudinal reservation: matching source
constituent identity and source polyline are required. Coincident projected
geometry alone does not establish a shared grade. Missing grade evidence is counted explicitly
as a ground-level visual assumption. Signal posts require verified road width,
building clearance and clearance from actual vehicle corridors. Unsafe or
unverified posts are omitted and counted; intersection control still applies.
Late source metadata upgrades retained geometry without restarting its clock.
Segment deduplication preserves separate grade/source identities, so an unknown
geometry alias cannot disable a verified bridge reservation or inherit its
evidence. Local contact compaction runs in bounded batches during source churn.

The index retains source geometry for at most 120 presentation seconds across
inventory churn. It admits at most 2,048 paths, 65,536 path points, 8,192 segments,
65,536 spatial-grid entries, 250,000 candidate segment checks, 250,000 merged
interval comparisons and 256 junctions with 32 physical approaches each.
Roadside placement uses at most 65,536 route-clearance
checks. Overflow is explicit: new entries are held and signal aspects become red.
The source inventory remains intact.

The separate opposing-direction index admits 2,048 paths, 8,192 segments, 8,192
raw shared contacts, 512 initial sections and 65,536 approach intervals. Segment
pair checks and connected-interval comparisons each have a 250,000 work cap.
An exceeded limit holds eligible vehicles at their current positions; fresh
unverified entries remain hidden and an explicit overflow counter is reported.
Node identity reuse is one-to-one across source refreshes. New local junction
components cannot inherit the same prior node ID or duplicate signal head IDs.

Run the focused controller, bridge and road-hint tests with:

```sh
npm test --workspace @omnitwin/demo-web -- src/renderer/game/junctionTraffic.test.ts src/renderer/game/junctionTraffic.review.test.ts src/renderer/game/laneTraffic.test.ts src/demo/actorColumnsBridge.test.ts src/demo/actorFootprintClearance.test.ts
```

With the local development server running, `node tools/qa-city-junctions.mjs`
opens its own Chromium context and records a bounded real-source phase cycle.
`node tools/qa-city-junctions.mjs --pose wide --cold-playing --duration 65`
also exercises initial loading while the clock runs, including retained geometry
from several source inventory refreshes. Duration is bounded to 30–90 seconds.
Frames, video, detailed samples and hashes are written to the operating system's
temporary directory. `OMNITWIN_QA_BROWSER_CHANNEL` may select `chrome`, `msedge`
or `chromium`. This functional probe does not measure uncontaminated performance,
and its centre-distance checks do not replace independent checks of interpolated
rendered body envelopes.

The independent final cold-view record is
[`junction-cold-rendered-opposing-pass-20260909.json`](../evidence/junction-cold-rendered-opposing-pass-20260909.json).
It sampled every rendered actor across 356 frames and 74.949 presentation seconds,
including 650,519 vehicle-pair and 7,063,008 vehicle/pedestrian body checks: no
overlap, queue or phase violations; minimum same-lane headway was 8 m. This wide
view used vehicle sprites, so the test checks nominal body envelopes at actual
interpolated renderer positions and headings, not detailed mesh triangles.
All 11 monitored source hashes remained unchanged. All sampled signal node and
approach IDs were unique. The final pause advanced no frames, actors or signals.

Replay of the exact 17 captured source inventories stayed below every opposing
work limit (maximum 648 segment-pair and 708 merge comparisons). It did use one
`exclusiveSections` component for a direction-retracing source corridor; this
conservative presentation policy is part of the tested behavior. The GPU trace
checks controller phases, not signal-prop draw telemetry. A separate parent-run
inspection of the user's preserved wide view at 15:46 local time reported
`ready`, 46 heads, three draws and no signal-renderer error. This observation is
separate from the recorded independent body test. Earlier 64-actor summaries in
this directory are explicitly historical and superseded.
