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
