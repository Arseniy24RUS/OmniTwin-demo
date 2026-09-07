# OmniTwin Demo — implementation contract

## City-scale repair campaign — owner approved 2026-09-07

Current implementation sequence (supersedes the small-person-fixture default, not observed statistics):

1. **Implemented; production-preview visual QA accepted** — atomic materials, governor recovery, metre-scale bodies, surface-aligned cars, and owner-requested far firefly LOD. Four real desktop/mobile Playwright tests pass on the production build; all 32 final PNGs were opened. Selection refresh no longer reopens the mobile sheet. After native tile/idle stabilization both paused checks recorded zero new frames in 2.2 seconds. Public deployment verification remains separate from this local acceptance.
2. **Built locally; not visually accepted for activation** — immutable seven-district geography/assignment pack and coherent 1,177,058-person fictional baseline. All seven real-browser views load, but some street views still look sparse and general-plan flows cluster too narrowly. Observed 2024 sex/age marginals seed an explicitly fictional 2026 reference, never a 2026 observation. Legacy 8,246 remains the public default.
3. **Implemented and tested locally; cloud activation pending** — indexed async profiles/occupancy/scenarios, shared canonical Firebase-compatible profile resolver and immutable-asset publisher. No V2 storage upload or backend deployment has occurred in this campaign. Public activation requires compatible backend, uploaded verified assets, and the remaining visual gates. No OpenRouter key or spending-cap changes.

The current source/artifact lineage and limits are recorded in `docs/CITY_V2_DATA_RU.md`; screenshot acceptance and remaining release work are in `docs/CITY_REPAIR_CHECKPOINT_RU.md`.

### Scene contract and specialist ownership

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
