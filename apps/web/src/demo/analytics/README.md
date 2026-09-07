# Public demo analytics

`DemoAnalytics` and `DemoScenarios` receive the same loaded `StaticDemoProvider` and `DemoContextV1` as the city and person inspectors. They make no API requests and never load a scientific run.

## Official city reference

`DemoAnalytics` defaults to the separate `provider.observedCity` reference; `analyticsSource: 'fictional'` explicitly selects the original character analytics. Unsupported observed territories or unavailable reference data show an explicit no-data state, never synthetic fallback. `observedYear` is independent of the demographic scenario year. The official view never maps an aggregate age/sex group to fictional individual records.

Exports: `ObservedAnalytics({reference, year, onYearChange, onFictional})`; `ObservedSummary({reference, year, onAnalytics, onScenarios, characterCount})`. Summary labels the fictional character count separately, below the dated official population. Scalar history comes from `reference.history ?? reference.snapshots`; selectable years come only from verified age/sex snapshots. Missing historical sex counts display as missing and are not exported as invented values.

The official SVG displays actual closed five-year bands and keeps any open-ended tail (85+ in the reviewed 2023 artifact, 100+ in 2024) outside the equal-width pyramid. No broad-bin expansion or interpolation is performed. The full chart measures its CSS container and recomputes its geometry; the compact summary uses the same bins with fewer labels. Two SVG figures per view, no animation, no added renderer dependency, and 44px year/source/export controls. Mobile stacks the age structure before historical detail and leaves exact tables available below. Main integration owns browser screenshots.

`SeriesChart` accepts optional provenance text and source-revision break years. Revision labels come from the reference metadata, not an assumed explanation such as a particular census adjustment. Source breaks split the line while retaining both published points. Official CSV contains source IDs/URLs, date, territory and OKTMO in every row, historical totals, known sex totals and the selected age partition; it never contains character rows or future scenario years.

## Preserved from OmniTwin

- Mirrored age/sex SVG pyramid, canonical stock-versus-period rows, latest-stock normalization, signed birth/death/migration components, visible synthetic provenance, and explicit missing values.
- The existing aggregate CSV implementation and its disclosure/export tests. Default research-style disclosure behavior is unchanged. Public fictional exports explicitly select a threshold of 1 because their complete individual fixture is intentionally public; the separately preserved legacy export keeps its original default threshold.
- CSV adds dataset, scenario, and representation columns so exported comparisons remain attributable. Disclosure grouping includes dataset/scenario identity.
- Numeric display tests, original small-cell/complementary suppression tests, file-picker and delayed Blob-URL release tests.

## Connected behavior

Territory, scenario, and demographic year update shared context. Selecting a pyramid bar supplies an exact age/sex cohort to the main app. Selecting a trend point changes demographic year. Presentation minutes are independent; analytical transforms depend only on provider, demographic year, scenario, territory and local filters.

Prepared scenario A/B views read real differences between fixture snapshots and use the same axis maximum for both pyramids. A is `context.comparisonScenario` (default baseline); B is `context.scenario`. Neither is local component state, so root URL restoration and global controls remain authoritative. Initially identical scenarios honestly show zero, with a prompt to select another B. Exports of identical scenarios contain one copy of their aggregates, not doubled rows. The local browser draft is explicitly `uncomputed`; changing its seven assumptions never alters prepared results.

Age/sex/employment cohort filters apply to population, pyramids, trends, canonical rows and scenario comparison CSV. The pure `cohortSnapshot` counts the same active fictional records and uses the provider's age/employment functions. Every year is a new cross-section: it is not a fixed panel of the same people. Employment totals and the number of distinct households containing selected residents are exact. Cohort-specific event attribution is unavailable; all six event values and their coverage are null, the component chart is replaced by an explicit explanation, and no cohort stock-flow balance is claimed. CSV adds `cohort_age_band`, `cohort_sex`, `cohort_employment` and `analysis_scope` so a selected population cannot masquerade as a territorial total. Excluded sex bars are omitted rather than displayed as measured zero. The separate immutable legacy section is explicitly whole-territory and does not inherit cohort filters.

Chart patch design: retain the existing SVG pyramid/time-series/table renderer and responsive order. Counts are exact fictional person units, missing event values remain gaps/nulls, and keyboard drill-down is preserved. Memoized transforms depend on primitive cohort fields, scenario and territory, not the presentation clock. This focused statistical/React pass changes scope and provenance, not the approved visual language; integration owns browser screenshots.

Stocks are at January 1 of year Y. Their events cover Y−1; the initial 2026 fixture has no preceding transition and its events remain null. The legacy 2025→2026 bundle is shown separately and never concatenated with the expanded fixture trajectory. One exact geographic level is selected, preventing parent/child double counting.

## Verification

Run from the demo repository root:

```text
node node_modules/vitest/vitest.mjs run --root apps/web --maxWorkers=1 src/demo/analytics
node node_modules/typescript/bin/tsc --project apps/web/tsconfig.json --noEmit --pretty false
```

The analytical suite contains 35 tests, including exact official counts and reviewed 2024 age geometry, official/source/date CSV contracts, missing historical sex partitions, open-ended ages, source breaks, unsupported territories, 707 selected fictional women aged 18–34 versus 8,246 fictional people, yearly cohort/list agreement, CSV wiring, global A/B rerendering and duplicate-free same-scenario export. Overall rendered desktop/mobile QA belongs to the app integration checks; component tests do not assert browser visual readiness.
