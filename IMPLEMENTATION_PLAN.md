# OmniTwin Demo — implementation contract

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
